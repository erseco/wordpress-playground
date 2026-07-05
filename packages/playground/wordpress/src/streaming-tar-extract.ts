/**
 * Bounded-memory streaming extraction of a solid `.tar.zst` WordPress core
 * bundle into a PHP-WASM MEMFS.
 *
 * Pipeline: compressed bytes → (zstddec streaming | native DecompressionStream)
 * → a ReadableStream of decoded tar bytes → an incremental USTAR/GNU-longlink
 * parser that writes each entry into MEMFS as it is decoded. The full
 * uncompressed tar is NEVER materialized: at any instant we hold only a partial
 * 512-byte header, the current entry's bytes, and one decoded chunk (~128 KiB).
 *
 * No shipping browser exposes `DecompressionStream("zstd")`, so the small
 * `zstddec` WASM decoder is used for the zstd codec; browser-native codecs
 * (gzip/deflate/brotli) use `DecompressionStream`.
 *
 * Path safety: "\\"→"/", absolute paths and ".." segments are rejected (fail
 * loud), empty/`.` segments skipped — no TAR-slip. Symlinks and other exotic
 * entry types are ignored. Malformed/truncated archives throw.
 *
 * Adapted for wordpress-playground from the measured PoC in
 * erseco/wordpress-playground#2 and the sibling *-playground forks.
 */

const BLOCK = 512;

/** zstd frame magic number: 0x28 0xB5 0x2F 0xFD (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
/** ZIP local-file-header magic: "PK\x03\x04". */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export type TarCodec = 'zstd' | 'gzip' | 'deflate' | 'br';

export interface TarFileEntry {
	type: 'file';
	path: string;
	data: Uint8Array;
}
export interface TarDirEntry {
	type: 'dir';
	path: string;
}
export type TarEntry = TarFileEntry | TarDirEntry;

export interface TarExtractStats {
	fileCount: number;
	dirCount: number;
	phpCount: number;
	bytesWritten: number;
	/** Peak JS-side working buffer in bytes (leftover + current entry). */
	maxBuffered: number;
}

/** Minimal PHP-WASM filesystem surface needed to write an extracted tree. */
export interface PhpFsTarget {
	mkdirTree(path: string): void;
	writeFile(path: string, data: Uint8Array): void;
	fileExists?(path: string): boolean;
}

/** True when the bytes begin with the zstd frame magic. */
export function isZstdBundle(bytes: Uint8Array): boolean {
	return ZSTD_MAGIC.every((b, i) => bytes[i] === b);
}

/** True when the bytes begin with the ZIP local-file-header magic. */
export function isZipBundle(bytes: Uint8Array): boolean {
	return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Sanitize a raw tar entry name. Rejects absolute paths and ".." traversal
 * (throws), normalizes separators, drops "." / empty segments. Returns the safe
 * relative path, or "" for an empty entry the caller should skip.
 */
export function sanitizeTarPath(rawName: string): string {
	const normalized = String(rawName).replaceAll('\\', '/');
	if (normalized.startsWith('/')) {
		throw new Error(`Unsafe tar entry (absolute path): ${rawName}`);
	}
	const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.some((s) => s === '..')) {
		throw new Error(`Unsafe tar entry (path traversal): ${rawName}`);
	}
	return segments.join('/');
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
	const raw = block.subarray(offset, offset + length);
	let s = '';
	for (const byte of raw) {
		if (byte === 0 || byte === 0x20) {
			if (s) break;
			continue;
		}
		s += String.fromCharCode(byte);
	}
	return s ? Number.parseInt(s, 8) : 0;
}

function readCString(
	block: Uint8Array,
	offset: number,
	length: number
): string {
	let end = offset;
	const limit = offset + length;
	while (end < limit && block[end] !== 0) end += 1;
	return new TextDecoder().decode(block.subarray(offset, end));
}

function isZeroBlock(block: Uint8Array): boolean {
	for (let i = 0; i < BLOCK; i += 1) {
		if (block[i] !== 0) return false;
	}
	return true;
}

interface PendingEntry {
	name: string;
	prefix: string;
	size: number;
	typeflag: string;
	isLongLink: boolean;
}

/**
 * Incremental USTAR/GNU tar parser. Feed arbitrary byte chunks via push(); it
 * invokes onEntry({ type, path, data }) for each complete file/directory entry.
 * Directory entries carry no data. Bounded memory: it never buffers more than a
 * partial header + the current entry + leftover bytes (tracked in maxBuffered).
 */
export class StreamingTarParser {
	private onEntry: (entry: TarEntry) => void;
	private leftover: Uint8Array = new Uint8Array(0);
	private state: 'header' | 'data' | 'pad' = 'header';
	private entry: PendingEntry | null = null;
	private dataChunks: Uint8Array[] = [];
	private dataFilled = 0;
	private padRemaining = 0;
	private pendingLongName: string | null = null;
	private zeroBlocks = 0;
	private ended = false;

	maxBuffered = 0;
	fileCount = 0;
	dirCount = 0;
	phpCount = 0;
	bytesWritten = 0;

	constructor({ onEntry }: { onEntry?: (entry: TarEntry) => void } = {}) {
		this.onEntry = onEntry ?? (() => {});
	}

	private track(extra = 0): void {
		const total = this.leftover.length + this.dataFilled + extra;
		if (total > this.maxBuffered) this.maxBuffered = total;
	}

	push(chunk: Uint8Array): void {
		if (chunk?.length) {
			// Append to leftover. This concatenation is bounded: leftover is
			// always < 512 bytes in header/pad state, and in data state we
			// drain into dataChunks immediately below.
			const merged = new Uint8Array(this.leftover.length + chunk.length);
			merged.set(this.leftover, 0);
			merged.set(chunk, this.leftover.length);
			this.leftover = merged;
		}
		this.track();
		this.drain();
	}

	private drain(): void {
		let progress = true;
		while (progress) {
			progress = false;

			if (this.state === 'header') {
				if (this.leftover.length < BLOCK) break;
				const header = this.leftover.subarray(0, BLOCK);
				this.leftover = this.leftover.subarray(BLOCK);

				if (isZeroBlock(header)) {
					this.zeroBlocks += 1;
					progress = true;
					continue;
				}
				this.zeroBlocks = 0;

				const size = readOctal(header, 124, 12);
				const typeflag = String.fromCharCode(header[156]) || '0';
				const name = readCString(header, 0, 100);
				const prefix = readCString(header, 345, 155);
				this.entry = {
					name,
					prefix,
					size,
					typeflag,
					isLongLink: typeflag === 'L',
				};
				this.dataChunks = [];
				this.dataFilled = 0;

				if (size > 0) {
					this.state = 'data';
				} else {
					this.finishEntry();
				}
				progress = true;
				continue;
			}

			if (this.state === 'data') {
				const need = this.entry!.size - this.dataFilled;
				if (need <= 0) {
					this.finishEntry();
					continue;
				}
				if (this.leftover.length === 0) break;
				const take = Math.min(need, this.leftover.length);
				this.dataChunks.push(this.leftover.subarray(0, take));
				this.dataFilled += take;
				this.leftover = this.leftover.subarray(take);
				this.track();
				if (this.dataFilled === this.entry!.size) {
					this.finishEntry();
				}
				progress = true;
				continue;
			}

			if (this.state === 'pad') {
				if (this.padRemaining === 0) {
					this.state = 'header';
					progress = true;
					continue;
				}
				if (this.leftover.length === 0) break;
				const skip = Math.min(this.padRemaining, this.leftover.length);
				this.leftover = this.leftover.subarray(skip);
				this.padRemaining -= skip;
				progress = true;
			}
		}
	}

	private concatData(): Uint8Array {
		const out = new Uint8Array(this.dataFilled);
		let offset = 0;
		for (const c of this.dataChunks) {
			out.set(c, offset);
			offset += c.length;
		}
		return out;
	}

	private finishEntry(): void {
		const entry = this.entry!;
		const data = this.concatData();
		this.dataChunks = [];
		// Set up padding to the next 512-byte boundary before emitting, so the
		// state machine stays consistent even if onEntry throws.
		const remainder = entry.size % BLOCK;
		this.padRemaining = remainder === 0 ? 0 : BLOCK - remainder;
		this.state = this.padRemaining > 0 ? 'pad' : 'header';
		this.dataFilled = 0;
		this.entry = null;

		if (entry.isLongLink) {
			// GNU longlink body is the full path (NUL-terminated) for the NEXT
			// entry.
			this.pendingLongName = new TextDecoder()
				.decode(data)
				.replace(/\0.*$/, '');
			return;
		}

		const rawName =
			this.pendingLongName ??
			(entry.prefix ? `${entry.prefix}/${entry.name}` : entry.name);
		this.pendingLongName = null;

		// Directory entries: typeflag '5', or a trailing-slash name.
		const isDir = entry.typeflag === '5' || rawName.endsWith('/');
		const path = sanitizeTarPath(rawName);
		if (!path) return; // empty after sanitization — skip

		if (isDir) {
			this.dirCount += 1;
			this.onEntry({ type: 'dir', path });
			return;
		}
		// Only regular files ('0' or '\0'); ignore symlinks/other exotic types.
		if (entry.typeflag !== '0' && entry.typeflag !== '\0') return;
		this.fileCount += 1;
		this.bytesWritten += data.length;
		if (path.endsWith('.php')) this.phpCount += 1;
		this.onEntry({ type: 'file', path, data });
	}

	end(): TarExtractStats {
		this.ended = true;
		// A well-formed archive ends with >=1 zero block. We do NOT tolerate a
		// half-read entry: that means the stream was truncated.
		if (
			this.state === 'data' &&
			this.dataFilled < (this.entry?.size ?? 0)
		) {
			throw new Error(
				`Truncated tar stream: entry ${this.entry?.name} expected ${this.entry?.size} bytes, got ${this.dataFilled}`
			);
		}
		return this.stats();
	}

	stats(): TarExtractStats {
		return {
			fileCount: this.fileCount,
			dirCount: this.dirCount,
			phpCount: this.phpCount,
			bytesWritten: this.bytesWritten,
			maxBuffered: this.maxBuffered,
		};
	}
}

/**
 * Build a ReadableStream of decoded tar bytes from the compressed bundle.
 * gzip/deflate/brotli use the browser-native DecompressionStream; zstd uses
 * zstddec's streaming generator (native DecompressionStream("zstd") is absent
 * in every shipping browser). The generator is lazy — it yields ~128 KiB chunks
 * and holds only the zstd window in WASM, so the JS side never sees the whole
 * tar.
 */
export async function createDecodedTarStream(
	compressed: Uint8Array,
	codec: TarCodec
): Promise<ReadableStream<Uint8Array>> {
	const normalized = codec === 'br' ? 'brotli' : codec;
	if (typeof DecompressionStream !== 'undefined') {
		try {
			const ds = new DecompressionStream(normalized as CompressionFormat);
			return new Response(compressed as BodyInit).body!.pipeThrough(ds);
		} catch {
			// Not natively supported — fall through to a bundled decoder.
		}
	}
	if (normalized === 'zstd') {
		const { ZSTDDecoder } = await import('zstddec/stream');
		const decoder = new ZSTDDecoder();
		await decoder.init();
		const generator = decoder.decodeStreaming([compressed]);
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				const { value, done } = generator.next();
				if (done) controller.close();
				else controller.enqueue(value);
			},
		});
	}
	throw new Error(`No streaming decoder available for codec "${codec}".`);
}

export interface ExtractTarStreamOptions {
	onProgress?: (progress: { fileCount: number; bytes: number }) => void;
	/** When false, existing files are skipped (parity with unzip overwrite=false). */
	overwriteFiles?: boolean;
}

/**
 * Stream a decoded tar into MEMFS, one entry at a time, writing each file via
 * the PHP-WASM filesystem (mkdirTree + writeFile) without ever holding the
 * whole archive. Returns extraction stats (file/dir/php counts, bytes, peak JS
 * buffer). Throws on malformed/truncated archives and on unsafe entry paths.
 */
export async function extractTarStreamToPhp(
	tarStream: ReadableStream<Uint8Array>,
	php: PhpFsTarget,
	targetRoot: string,
	options: ExtractTarStreamOptions = {}
): Promise<TarExtractStats> {
	const { onProgress = () => {}, overwriteFiles = true } = options;
	const root = String(targetRoot).replace(/\/+$/, '');
	const createdDirs = new Set<string>();

	const ensureDir = (dir: string): void => {
		if (!dir || createdDirs.has(dir)) return;
		php.mkdirTree(dir);
		let d: string | null = dir;
		while (d && !createdDirs.has(d)) {
			createdDirs.add(d);
			d = d.substring(0, d.lastIndexOf('/')) || null;
		}
	};

	const parser = new StreamingTarParser({
		onEntry: (entry) => {
			const dest = `${root}/${entry.path}`;
			if (entry.type === 'dir') {
				ensureDir(dest);
				return;
			}
			const lastSlash = dest.lastIndexOf('/');
			if (lastSlash > 0) ensureDir(dest.substring(0, lastSlash));
			if (!overwriteFiles && php.fileExists?.(dest)) {
				return;
			}
			php.writeFile(dest, entry.data);
			if (parser.fileCount % 1000 === 0) {
				onProgress({
					fileCount: parser.fileCount,
					bytes: parser.bytesWritten,
				});
			}
		},
	});

	ensureDir(root);
	const reader = tarStream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) parser.push(value);
	}
	return parser.end();
}
