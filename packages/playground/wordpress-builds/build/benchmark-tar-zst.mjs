#!/usr/bin/env node
//
// benchmark-tar-zst.mjs — reproducible, local benchmark of the WordPress core
// bundle switch from ZIP to solid tar.zst.
//
// Measures (no browser, no PHP needed):
//   * committed ZIP size vs generated tar.zst size (MiB + %),
//   * regular-file count,
//   * end-to-end JS streaming extraction (zstddec decode → StreamingTarParser →
//     in-memory FS writes), median of N runs, plus peak JS working buffer.
//
// The PHP-WASM extraction comparison (PHP ZipArchive vs streaming tar.zst into a
// real MEMFS) and the per-engine cold-boot / app-ready numbers are measured
// separately in the browser (Playwright) / on the deployed preview — see
// docs/streaming-tar-zst-core-bundle.md for the methodology.
//
// Usage:
//   node build/benchmark-tar-zst.mjs                 # default versions, 5 runs
//   node build/benchmark-tar-zst.mjs --runs=3 --versions=6.3,6.8,6.9,7.0
//
// Requires Node >= 22.15 (native node:zlib zstd, for building any missing
// tar.zst on the fly).

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StreamingTarParser } from '../../wordpress/src/streaming-tar-extract.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WP_DIR = path.resolve(HERE, '../src/wordpress');

function parseArgs(argv) {
	const opts = { runs: 5, versions: ['6.3', '6.8', '6.9', '7.0'] };
	for (const arg of argv) {
		if (arg.startsWith('--runs=')) opts.runs = Number.parseInt(arg.slice(7), 10);
		else if (arg.startsWith('--versions='))
			opts.versions = arg.slice(11).split(',').filter(Boolean);
	}
	return opts;
}

const MiB = (n) => (n / 1048576).toFixed(2);
const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function decodeToChunks(compressed) {
	const { ZSTDDecoder } = await import('zstddec/stream');
	const decoder = new ZSTDDecoder();
	await decoder.init();
	return [...decoder.decodeStreaming([compressed])];
}

/** One streaming-extraction pass into an in-memory FS; returns { ms, maxBuffered, fileCount }. */
function extractOnce(chunks) {
	const files = new Map();
	const parser = new StreamingTarParser({
		onEntry: (e) => {
			if (e.type === 'file') files.set(e.path, e.data);
		},
	});
	const t0 = performance.now();
	for (const chunk of chunks) parser.push(chunk);
	const stats = parser.end();
	const ms = performance.now() - t0;
	return { ms, maxBuffered: stats.maxBuffered, fileCount: stats.fileCount };
}

async function benchOne(slug, runs) {
	const zipPath = path.join(WP_DIR, `wp-${slug}.zip`);
	const tarZstPath = path.join(WP_DIR, `wp-${slug}.tar.zst`);
	if (!existsSync(tarZstPath)) {
		console.error(`  (skip wp-${slug}: no tar.zst — run build-tar-zst.mjs first)`);
		return null;
	}
	const zipSize = existsSync(zipPath) ? statSync(zipPath).size : null;
	const tarZstSize = statSync(tarZstPath).size;
	const compressed = new Uint8Array(readFileSync(tarZstPath));

	// Pre-decode once so the parse benchmark isn't dominated by zstd init.
	const chunks = await decodeToChunks(compressed);

	const parseTimes = [];
	let maxBuffered = 0;
	let fileCount = 0;
	for (let i = 0; i < runs; i += 1) {
		const r = extractOnce(chunks);
		parseTimes.push(r.ms);
		maxBuffered = Math.max(maxBuffered, r.maxBuffered);
		fileCount = r.fileCount;
	}

	// Full decode+parse (cold) median.
	const e2eTimes = [];
	for (let i = 0; i < runs; i += 1) {
		const t0 = performance.now();
		const c = await decodeToChunks(compressed);
		extractOnce(c);
		e2eTimes.push(performance.now() - t0);
	}

	const sizeDeltaPct =
		zipSize != null ? ((tarZstSize - zipSize) / zipSize) * 100 : null;
	return {
		slug,
		zipSize,
		tarZstSize,
		sizeDeltaPct,
		fileCount,
		parseMedianMs: median(parseTimes),
		e2eMedianMs: median(e2eTimes),
		maxBufferedMiB: maxBuffered / 1048576,
	};
}

async function main() {
	const { runs, versions } = parseArgs(process.argv.slice(2));
	console.log(
		`# tar.zst core bundle benchmark (median of ${runs}; Node ${process.version})\n`
	);
	const rows = [];
	for (const slug of versions) {
		const r = await benchOne(slug, runs);
		if (r) rows.push(r);
	}

	console.log(
		'| WordPress | ZIP size | tar.zst size | Size Δ | Files | JS parse (median) | JS decode+parse (median) | Peak JS buffer |'
	);
	console.log(
		'|---|---:|---:|---:|---:|---:|---:|---:|'
	);
	for (const r of rows) {
		console.log(
			`| ${r.slug} | ${r.zipSize != null ? MiB(r.zipSize) + ' MiB' : 'n/a'} | ` +
				`${MiB(r.tarZstSize)} MiB | ${r.sizeDeltaPct != null ? r.sizeDeltaPct.toFixed(1) + ' %' : 'n/a'} | ` +
				`${r.fileCount} | ${r.parseMedianMs.toFixed(1)} ms | ${r.e2eMedianMs.toFixed(1)} ms | ` +
				`${r.maxBufferedMiB.toFixed(2)} MiB |`
		);
	}
	console.log(
		'\nNote: JS parse = StreamingTarParser only (chunks pre-decoded). ' +
			'JS decode+parse = zstddec streaming decode + parse (cold). ' +
			'PHP-WASM ZipArchive vs tar.zst→MEMFS extraction and per-engine app-ready ' +
			'are measured separately (see docs/streaming-tar-zst-core-bundle.md).'
	);
}

main();
