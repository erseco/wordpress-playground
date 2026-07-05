import zlib from 'node:zlib';
import {
	createDecodedTarStream,
	extractTarStreamToPhp,
	isZipBundle,
	isZstdBundle,
	sanitizeTarPath,
	StreamingTarParser,
	type PhpFsTarget,
	type TarEntry,
} from './streaming-tar-extract';

// ---------------------------------------------------------------------------
// Self-contained USTAR / GNU-longlink tar builder (kept in-test so the spec is
// hermetic and does not import across package boundaries). Mirrors the on-disk
// format produced by build/lib/tar-ustar.mjs.
// ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value: number, length: number): string {
	return value.toString(8).padStart(length - 1, '0') + '\0';
}

function header(opts: {
	name: string;
	size: number;
	typeflag?: string;
	prefix?: string;
	mode?: number;
}): Buffer {
	const { name, size, typeflag = '0', prefix = '', mode = 0o644 } = opts;
	const block = Buffer.alloc(BLOCK, 0);
	block.write(name, 0, 100, 'utf8');
	block.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
	block.write(octal(0, 8), 108, 8, 'ascii');
	block.write(octal(0, 8), 116, 8, 'ascii');
	block.write(octal(size, 12), 124, 12, 'ascii');
	block.write(octal(0, 12), 136, 12, 'ascii');
	block.write('        ', 148, 8, 'ascii'); // checksum placeholder
	block.write(typeflag, 156, 1, 'ascii');
	block.write('ustar\0', 257, 6, 'ascii');
	block.write('00', 263, 2, 'ascii');
	if (prefix) block.write(prefix, 345, 155, 'utf8');
	let sum = 0;
	for (let i = 0; i < BLOCK; i += 1) sum += block[i];
	block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
	return block;
}

function pad(bytes: Buffer): Buffer {
	const rem = bytes.length % BLOCK;
	return rem === 0
		? bytes
		: Buffer.concat([bytes, Buffer.alloc(BLOCK - rem)]);
}

type BuildEntry =
	| { name: string; data: Buffer | string }
	| { name: string; type: 'dir' }
	| { name: string; type: 'symlink'; linkname: string }
	| { longLink: string; name: string; data: Buffer | string }
	| { name: string; prefix: string; data: Buffer | string };

function buildTar(entries: BuildEntry[], { eof = true } = {}): Uint8Array {
	const parts: Buffer[] = [];
	for (const e of entries as any[]) {
		if (e.type === 'dir') {
			parts.push(header({ name: `${e.name}/`, size: 0, typeflag: '5' }));
			continue;
		}
		if (e.type === 'symlink') {
			const h = header({ name: e.name, size: 0, typeflag: '2' });
			h.write(e.linkname, 157, 100, 'utf8');
			// recompute checksum after writing linkname
			h.write('        ', 148, 8, 'ascii');
			let sum = 0;
			for (let i = 0; i < BLOCK; i += 1) sum += h[i];
			h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
			parts.push(h);
			continue;
		}
		if (e.longLink) {
			const longName = Buffer.from(`${e.longLink}\0`, 'utf8');
			parts.push(
				header({
					name: '././@LongLink',
					size: longName.length,
					typeflag: 'L',
				})
			);
			parts.push(pad(longName));
		}
		const data = Buffer.isBuffer(e.data)
			? e.data
			: Buffer.from(e.data ?? '', 'utf8');
		parts.push(
			header({ name: e.name, size: data.length, prefix: e.prefix ?? '' })
		);
		parts.push(pad(data));
	}
	if (eof) parts.push(Buffer.alloc(BLOCK * 2, 0));
	return new Uint8Array(Buffer.concat(parts));
}

function collect(bytes: Uint8Array, chunkSize = bytes.length) {
	const entries: TarEntry[] = [];
	const parser = new StreamingTarParser({ onEntry: (e) => entries.push(e) });
	for (let i = 0; i < bytes.length; i += chunkSize) {
		parser.push(bytes.subarray(i, i + chunkSize));
	}
	const stats = parser.end();
	return { entries, stats, parser };
}

/** In-memory PHP-WASM filesystem stand-in. */
function fakePhp() {
	const files = new Map<string, Uint8Array>();
	const dirs = new Set<string>(['']);
	const php: PhpFsTarget = {
		mkdirTree(p: string) {
			dirs.add(p.replace(/\/+$/, ''));
		},
		writeFile(p: string, data: Uint8Array) {
			files.set(p, data);
		},
		fileExists(p: string) {
			return files.has(p) || dirs.has(p.replace(/\/+$/, ''));
		},
	};
	return { php, files, dirs };
}

async function streamOf(bytes: Uint8Array, chunkSize = 65536) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (let i = 0; i < bytes.length; i += chunkSize) {
				controller.enqueue(bytes.subarray(i, i + chunkSize));
			}
			controller.close();
		},
	});
}

const text = (u?: Uint8Array) => (u ? new TextDecoder().decode(u) : undefined);

// ---------------------------------------------------------------------------

describe('sanitizeTarPath', () => {
	it('accepts normal relative paths', () => {
		expect(sanitizeTarPath('wp-includes/version.php')).toBe(
			'wp-includes/version.php'
		);
	});
	it('normalizes backslashes to forward slashes', () => {
		expect(sanitizeTarPath('wp-admin\\css\\a.css')).toBe(
			'wp-admin/css/a.css'
		);
	});
	it('drops "." and empty segments', () => {
		expect(sanitizeTarPath('./a//b/./c')).toBe('a/b/c');
	});
	it('rejects absolute paths', () => {
		expect(() => sanitizeTarPath('/etc/passwd')).toThrow(/absolute path/);
	});
	it('rejects ".." traversal', () => {
		expect(() => sanitizeTarPath('../../etc/passwd')).toThrow(
			/path traversal/
		);
		expect(() => sanitizeTarPath('a/../../b')).toThrow(/path traversal/);
	});
	it('rejects backslash traversal after normalization', () => {
		expect(() => sanitizeTarPath('..\\..\\windows')).toThrow(
			/path traversal/
		);
	});
	it('returns "" for empty / dot-only names', () => {
		expect(sanitizeTarPath('.')).toBe('');
		expect(sanitizeTarPath('')).toBe('');
	});
});

describe('isZstdBundle / isZipBundle', () => {
	it('detects zstd magic', () => {
		expect(
			isZstdBundle(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x0]))
		).toBe(true);
		expect(isZstdBundle(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
			false
		);
	});
	it('detects zip magic', () => {
		expect(isZipBundle(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(
			true
		);
		expect(isZipBundle(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(
			false
		);
	});
});

describe('StreamingTarParser', () => {
	it('parses normal files', () => {
		const { entries, stats } = collect(
			buildTar([
				{ name: 'a.txt', data: 'hello' },
				{ name: 'b.php', data: '<?php echo 1;' },
			])
		);
		expect(entries.map((e) => e.path)).toEqual(['a.txt', 'b.php']);
		expect(text((entries[0] as any).data)).toBe('hello');
		expect(stats.fileCount).toBe(2);
		expect(stats.phpCount).toBe(1);
	});

	it('parses nested directories and reconstructs paths', () => {
		const { entries } = collect(
			buildTar([
				{ name: 'wp-content/themes/x/style.css', data: 'body{}' },
			])
		);
		expect(entries[0].path).toBe('wp-content/themes/x/style.css');
	});

	it('emits explicit (empty) directory entries', () => {
		const { entries, stats } = collect(
			buildTar([
				{ name: 'wp-content/uploads', type: 'dir' },
				{ name: 'wp-content/uploads/.htaccess', data: 'deny' },
			])
		);
		expect(entries[0]).toEqual({ type: 'dir', path: 'wp-content/uploads' });
		expect(stats.dirCount).toBe(1);
		expect(stats.fileCount).toBe(1);
	});

	it('resolves GNU ././@LongLink long paths', () => {
		const longName = 'wp-content/plugins/' + 'a'.repeat(120) + '/index.php';
		const { entries } = collect(
			buildTar([{ longLink: longName, name: 'truncated', data: 'x' }])
		);
		expect(entries[0].path).toBe(longName);
	});

	it('resolves USTAR prefix/name split long paths', () => {
		const prefix = 'wp-content/themes/' + 'p'.repeat(120);
		const name = 'style.css';
		const { entries } = collect(buildTar([{ name, prefix, data: 'ok' }]));
		expect(entries[0].path).toBe(`${prefix}/${name}`);
	});

	it('reassembles headers split across chunk boundaries', () => {
		const bytes = buildTar([
			{ name: 'dir/file-one.txt', data: 'one' },
			{ name: 'dir/file-two.txt', data: 'two' },
		]);
		// Feed 37-byte chunks: no header/body aligns to a chunk edge.
		const { entries } = collect(bytes, 37);
		expect(entries.map((e) => e.path)).toEqual([
			'dir/file-one.txt',
			'dir/file-two.txt',
		]);
		expect(text((entries[1] as any).data)).toBe('two');
	});

	it('reassembles file bodies split across chunk boundaries', () => {
		const big = Buffer.alloc(5000, 0x41); // 'A' * 5000, spans 10 blocks
		const { entries } = collect(
			buildTar([{ name: 'big.bin', data: big }]),
			13
		);
		expect((entries[0] as any).data.length).toBe(5000);
		expect(Buffer.from((entries[0] as any).data).equals(big)).toBe(true);
	});

	it('handles padding and multi-zero-block EOF', () => {
		// 'abc' (3 bytes) needs 509 bytes of padding to the next block.
		const { entries, stats } = collect(
			buildTar([{ name: 'p.txt', data: 'abc' }])
		);
		expect(text((entries[0] as any).data)).toBe('abc');
		expect(stats.fileCount).toBe(1);
	});

	it('throws on a truncated archive (half-read entry)', () => {
		// Header declares 1000 bytes but only 100 follow, no EOF.
		const h = header({ name: 'trunc.bin', size: 1000 });
		const partial = Buffer.concat([h, Buffer.alloc(100, 0x42)]);
		expect(() => collect(new Uint8Array(partial))).toThrow(/Truncated/);
	});

	it('ignores symlink and other exotic entry types', () => {
		const { entries, stats } = collect(
			buildTar([
				{ name: 'evil-link', type: 'symlink', linkname: '/etc/passwd' },
				{ name: 'real.txt', data: 'ok' },
			])
		);
		expect(entries.map((e) => e.path)).toEqual(['real.txt']);
		expect(stats.fileCount).toBe(1);
	});

	it('throws on an unsafe (traversal) entry name', () => {
		expect(() =>
			collect(buildTar([{ name: '../escape.txt', data: 'x' }]))
		).toThrow(/path traversal/);
	});

	it('keeps buffering bounded (maxBuffered << total archive size)', () => {
		// 40 files x 10 KiB = 400 KiB archive, fed in 4 KiB chunks.
		const entries = Array.from({ length: 40 }, (_, i) => ({
			name: `f${i}.bin`,
			data: Buffer.alloc(10240, i),
		}));
		const { stats } = collect(buildTar(entries), 4096);
		// Never buffers more than one entry (~10 KiB) + a chunk + a header.
		expect(stats.maxBuffered).toBeLessThan(32 * 1024);
		expect(stats.fileCount).toBe(40);
	});
});

describe('extractTarStreamToPhp', () => {
	it('writes files and creates parent directories in MEMFS', async () => {
		const { php, files, dirs } = fakePhp();
		const stream = await streamOf(
			buildTar([
				{ name: 'index.php', data: '<?php' },
				{ name: 'wp-includes/version.php', data: 'v' },
			])
		);
		const stats = await extractTarStreamToPhp(stream, php, '/wordpress');
		expect(text(files.get('/wordpress/index.php'))).toBe('<?php');
		expect(text(files.get('/wordpress/wp-includes/version.php'))).toBe('v');
		expect(dirs.has('/wordpress/wp-includes')).toBe(true);
		expect(stats.fileCount).toBe(2);
	});

	it('respects overwriteFiles=false (skips existing files)', async () => {
		const { php, files } = fakePhp();
		files.set('/wp/keep.txt', new TextEncoder().encode('original'));
		const stream = await streamOf(
			buildTar([
				{ name: 'keep.txt', data: 'REPLACED' },
				{ name: 'new.txt', data: 'added' },
			])
		);
		await extractTarStreamToPhp(stream, php, '/wp', {
			overwriteFiles: false,
		});
		expect(text(files.get('/wp/keep.txt'))).toBe('original');
		expect(text(files.get('/wp/new.txt'))).toBe('added');
	});

	it('rejects a traversal entry before writing outside the root', async () => {
		const { php, files } = fakePhp();
		const stream = await streamOf(
			buildTar([{ name: '../../etc/evil', data: 'pwn' }])
		);
		await expect(extractTarStreamToPhp(stream, php, '/wp')).rejects.toThrow(
			/path traversal/
		);
		expect([...files.keys()].some((k) => k.includes('etc/evil'))).toBe(
			false
		);
	});
});

describe('createDecodedTarStream + round-trip (real zstd)', () => {
	function zstd(bytes: Uint8Array): Uint8Array {
		// node:zlib zstd (Node >= 22.15) — cast because the installed
		// @types/node may predate the zstd typings.
		const z = zlib as any;
		return new Uint8Array(
			z.zstdCompressSync(bytes, {
				params: {
					[z.constants.ZSTD_c_compressionLevel]: 19,
					[z.constants.ZSTD_c_windowLog]: 24,
				},
			})
		);
	}

	it('streams a .tar.zst through zstddec into MEMFS with content + count parity', async () => {
		const longName = 'wp-content/plugins/' + 'z'.repeat(140) + '/main.php';
		const binary = Buffer.alloc(3000);
		for (let i = 0; i < binary.length; i += 1) binary[i] = (i * 7) % 256;
		const tar = buildTar([
			{ name: 'index.php', data: '<?php // root' },
			{ name: 'wp-includes/version.php', data: "$wp_version='6.9';" },
			{ longLink: longName, name: 'trunc', data: 'plugin' },
			{ name: 'assets/blob.bin', data: binary },
		]);
		const compressed = zstd(tar);
		expect(isZstdBundle(compressed)).toBe(true);

		const stream = await createDecodedTarStream(compressed, 'zstd');
		const { php, files } = fakePhp();
		const stats = await extractTarStreamToPhp(stream, php, '/wordpress');

		expect(stats.fileCount).toBe(4);
		expect(text(files.get('/wordpress/index.php'))).toBe('<?php // root');
		expect(text(files.get(`/wordpress/${longName}`))).toBe('plugin');
		expect(
			Buffer.from(files.get('/wordpress/assets/blob.bin')!).equals(binary)
		).toBe(true);
	});

	it('file-count parity: mismatch is detectable via returned stats', async () => {
		const tar = buildTar([
			{ name: 'a.txt', data: '1' },
			{ name: 'b.txt', data: '2' },
		]);
		const stream = await createDecodedTarStream(zstd(tar), 'zstd');
		const { php } = fakePhp();
		const stats = await extractTarStreamToPhp(stream, php, '/wp');
		const expectedFileCount = 3; // deliberately wrong
		expect(stats.fileCount).not.toBe(expectedFileCount);
		expect(stats.fileCount).toBe(2);
	});
});
