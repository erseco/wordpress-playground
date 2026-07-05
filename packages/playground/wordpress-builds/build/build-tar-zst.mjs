#!/usr/bin/env node
//
// build-tar-zst.mjs — re-container the committed minified `wp-<v>.zip` core
// bundles into deterministic, zstd-compressed solid tars (`wp-<v>.tar.zst`) that
// the browser runtime extracts by streaming (see
// packages/playground/wordpress/src/streaming-tar-extract.ts), and regenerate
// src/wordpress/get-wordpress-module-details.ts with the new descriptor
// (format/container/codec/size/sha256/fileCount).
//
// Deterministic USTAR + GNU longlink (never PAX — the streaming parser and PHP
// tar readers do not honor PAX 'path' headers). zstd level 19 + long-distance
// matching. Requires Node >= 22.15 (native node:zlib zstd).
//
// Usage:
//   node build/build-tar-zst.mjs --all [--window-log=24]
//   node build/build-tar-zst.mjs --version=6.9 [--window-log=27] [--no-descriptor]
//   node build/build-tar-zst.mjs --verify           # recompute sha256, compare to descriptor
//
// The re-container path uses the `unzip` CLI (no fflate dependency, matching the
// repo's dependency-light build tooling). The canonical rebuild (build.js/Docker)
// tars the staged directory tree directly; both produce the same solid tar.

import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createUstarTar, normalizeEntries } from './lib/tar-ustar.mjs';
import { generateModuleDetailsSource } from './lib/generate-module-details.mjs';

if (typeof zlib.zstdCompressSync !== 'function') {
	console.error('Node >= 22.15 (native node:zlib zstd) is required.');
	process.exit(1);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WP_DIR = path.resolve(HERE, '../src/wordpress');
const VERSIONS_PATH = path.join(WP_DIR, 'wp-versions.json');
const DETAILS_PATH = path.join(WP_DIR, 'get-wordpress-module-details.ts');

// Kept in sync with build.js. Remote modules stay a GitHub master.zip.
const remoteWordPressModules = {
	trunk: {
		url:
			process.env.PLAYGROUND_TRUNK_ZIP_URL ??
			'https://github.com/WordPress/WordPress/archive/refs/heads/master.zip',
		size: 0,
	},
};

function parseArgs(argv) {
	const opts = {
		all: false,
		version: null,
		// windowLog 25 (32 MiB): same compression as 27 for these <=40 MiB
		// bundles, but a bounded multi-segment sliding window instead of the
		// single-segment whole-content buffer that >=26 forces on the decoder.
		windowLog: 25,
		descriptor: true,
		descriptorOnly: false,
		deleteZip: false,
		verify: false,
	};
	for (const arg of argv) {
		if (arg === '--all') opts.all = true;
		else if (arg === '--verify') opts.verify = true;
		else if (arg === '--no-descriptor') opts.descriptor = false;
		else if (arg === '--descriptor-only') opts.descriptorOnly = true;
		else if (arg === '--delete-zip') opts.deleteZip = true;
		else if (arg.startsWith('--version=')) opts.version = arg.slice(10);
		else if (arg.startsWith('--window-log='))
			opts.windowLog = Number.parseInt(arg.slice(13), 10);
		else {
			console.error(`Unknown argument: ${arg}`);
			process.exit(1);
		}
	}
	return opts;
}

function readVersions() {
	return JSON.parse(readFileSync(VERSIONS_PATH, 'utf8'));
}

function localSlugs(versions) {
	const remote = new Set(Object.keys(remoteWordPressModules));
	return Object.keys(versions).filter((slug) => !remote.has(slug));
}

/** Recursively read a directory into a { relativePath -> Uint8Array } map. */
function readTreeIntoFileMap(root) {
	const fileMap = {};
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(abs, rel);
			} else if (entry.isFile()) {
				fileMap[rel] = new Uint8Array(readFileSync(abs));
			}
			// symlinks/other types: WordPress core bundles contain none; skip.
		}
	};
	walk(root, '');
	return fileMap;
}

function compressTarZst(tar, windowLog) {
	return zlib.zstdCompressSync(tar, {
		params: {
			[zlib.constants.ZSTD_c_compressionLevel]: 19,
			[zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
			[zlib.constants.ZSTD_c_windowLog]: windowLog,
		},
	});
}

/** Re-container one wp-<slug>.zip into wp-<slug>.tar.zst; returns descriptor meta. */
function buildOne(slug, windowLog, deleteZip = false) {
	const zipPath = path.join(WP_DIR, `wp-${slug}.zip`);
	if (!existsSync(zipPath)) {
		throw new Error(`Missing source bundle: ${zipPath}`);
	}
	const tmp = mkdtempSync(path.join(tmpdir(), 'wp-tarzst-'));
	try {
		const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', tmp], {
			stdio: ['ignore', 'ignore', 'inherit'],
		});
		if (res.status !== 0) {
			throw new Error(`unzip failed for ${zipPath} (status ${res.status})`);
		}
		const fileMap = readTreeIntoFileMap(tmp);
		const entries = normalizeEntries(fileMap);
		const uncompressedBytes = entries.reduce(
			(n, e) => n + e.data.length,
			0
		);
		const tar = createUstarTar(entries, { mtime: 0 });
		const compressed = compressTarZst(tar, windowLog);
		const outPath = path.join(WP_DIR, `wp-${slug}.tar.zst`);
		writeFileSync(outPath, compressed);
		const sha256 = createHash('sha256').update(compressed).digest('hex');
		const meta = {
			slug,
			fileCount: entries.length,
			size: compressed.length,
			sha256,
			uncompressedBytes,
			tarBytes: tar.length,
			windowLog,
		};
		console.log(
			`wp-${slug}: ${entries.length} files, tar ${(tar.length / 1048576).toFixed(2)} MiB ` +
				`→ tar.zst ${(compressed.length / 1048576).toFixed(2)} MiB (wlog ${windowLog}), sha256 ${sha256.slice(0, 12)}…`
		);
		if (deleteZip) {
			// The zip is now a transient build source; tar.zst is the shipped
			// core bundle.
			rmSync(zipPath, { force: true });
		}
		return meta;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function writeDescriptor(versions, metaBySlug) {
	const latestStableVersion = Object.keys(versions).filter((v) =>
		v.match(/^\d/)
	)[0];
	const meta = {};
	for (const [slug, m] of Object.entries(metaBySlug)) {
		meta[slug] = {
			size: m.size,
			sha256: m.sha256,
			fileCount: m.fileCount,
		};
	}
	const source = generateModuleDetailsSource({
		versions,
		meta,
		remoteWordPressModules,
		latestStableVersion,
	});
	writeFileSync(DETAILS_PATH, source);
	console.log(`Wrote ${path.relative(process.cwd(), DETAILS_PATH)}`);
}

/** Verify committed .tar.zst files match the sha256/size in the descriptor. */
function verify(versions) {
	const source = readFileSync(DETAILS_PATH, 'utf8');
	let ok = true;
	for (const slug of localSlugs(versions)) {
		const tarZst = path.join(WP_DIR, `wp-${slug}.tar.zst`);
		if (!existsSync(tarZst)) {
			console.error(`MISSING artifact: wp-${slug}.tar.zst`);
			ok = false;
			continue;
		}
		const bytes = readFileSync(tarZst);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		const size = statSync(tarZst).size;
		const sizeOk = source.includes(`size: ${size},`);
		const shaOk = source.includes(`sha256: ${JSON.stringify(sha256)},`);
		if (sizeOk && shaOk) {
			console.log(`OK  wp-${slug}.tar.zst (${size} bytes, ${sha256.slice(0, 12)}…)`);
		} else {
			console.error(
				`FAIL wp-${slug}.tar.zst — descriptor mismatch (sizeOk=${sizeOk} shaOk=${shaOk})`
			);
			ok = false;
		}
	}
	if (!ok) process.exit(1);
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const versions = readVersions();

	if (opts.verify) {
		verify(versions);
		return;
	}

	if (opts.descriptorOnly) {
		// Regenerate the descriptor from the already-built tar.zst artifacts
		// (used by build.js after building a remote/trunk module that has no
		// local bundle to re-container).
		writeDescriptor(versions, mergeExistingMeta(versions, {}));
		return;
	}

	let slugs;
	if (opts.all) {
		slugs = localSlugs(versions);
	} else if (opts.version) {
		slugs = [opts.version];
	} else {
		console.error(
			'Specify --all, --version=<slug>, --descriptor-only, or --verify. See file header for usage.'
		);
		process.exit(1);
	}

	const metaBySlug = {};
	for (const slug of slugs) {
		metaBySlug[slug] = buildOne(slug, opts.windowLog, opts.deleteZip);
	}

	if (opts.descriptor) {
		// Merge with existing descriptor meta for slugs not rebuilt this run so a
		// single-version run does not wipe the other versions' metadata.
		const full = opts.all ? metaBySlug : mergeExistingMeta(versions, metaBySlug);
		writeDescriptor(versions, full);
	}

	console.log(JSON.stringify(metaBySlug, null, 2));
}

/**
 * When rebuilding a subset, keep the already-committed sha256/size/fileCount for
 * untouched local versions by parsing them back out of the current descriptor.
 */
function mergeExistingMeta(versions, metaBySlug) {
	const source = existsSync(DETAILS_PATH)
		? readFileSync(DETAILS_PATH, 'utf8')
		: '';
	const merged = { ...metaBySlug };
	for (const slug of localSlugs(versions)) {
		if (merged[slug]) continue;
		const re = new RegExp(
			`case '${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}':[\\s\\S]*?size: (\\d+),[\\s\\S]*?sha256: "([0-9a-f]*)",[\\s\\S]*?fileCount: (\\d+),`
		);
		const m = source.match(re);
		if (m) {
			merged[slug] = {
				size: Number(m[1]),
				sha256: m[2],
				fileCount: Number(m[3]),
			};
		}
	}
	return merged;
}

main();
