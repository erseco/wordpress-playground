#!/usr/bin/env node
//
// benchmark-tar-zst-browser.mjs — real browser benchmark (Playwright) for the
// tar.zst WordPress core bundle:
//   * in-browser tar.zst extraction (zstddec streaming decode → StreamingTarParser
//     → JS writes) across Chromium / Firefox / WebKit, median of N;
//   * network-throttled download of wp-<v>.zip vs wp-<v>.tar.zst (Chromium
//     DevTools Network.emulateNetworkConditions) — the slow-link benefit.
//
// The tar.zst side is pure JS (no PHP-WASM), so a small esbuild bundle of the
// real runtime extractor + zstddec is served to each engine. If a wp-<v>.zip is
// present the ZIP download baseline is included; otherwise it is skipped.
//
// Requires the Playwright browsers: `npx playwright install chromium firefox webkit`.
//
// Usage:
//   node build/benchmark-tar-zst-browser.mjs [--versions=6.9,7.0] [--runs=5]

import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import esbuild from 'esbuild';
import playwright from 'playwright';

const { chromium, firefox, webkit } = playwright;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const WP_DIR = path.resolve(HERE, '../src/wordpress');
const EXTRACTOR = path.resolve(
	HERE,
	'../../wordpress/src/streaming-tar-extract.ts'
);

function parseArgs(argv) {
	const opts = { versions: ['6.9', '7.0'], runs: 5 };
	for (const a of argv) {
		if (a.startsWith('--versions=')) opts.versions = a.slice(11).split(',');
		else if (a.startsWith('--runs=')) opts.runs = Number.parseInt(a.slice(7), 10);
	}
	return opts;
}

const PROFILES = [
	{ name: '40 Mbps (broadband)', bps: (40 * 1e6) / 8, latency: 20 },
	{ name: '8 Mbps (DSL/4G)', bps: (8 * 1e6) / 8, latency: 40 },
];

async function bundleHarness(runs) {
	const tmp = mkdtempSync(path.join(tmpdir(), 'tarzst-bench-'));
	const entry = path.join(tmp, 'entry.mjs');
	writeFileSync(
		entry,
		`
import { createDecodedTarStream, extractTarStreamToPhp } from ${JSON.stringify(EXTRACTOR)};
const median = (xs) => { const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
window.benchDownload = async (url) => { const t0=performance.now(); const b=await (await fetch(url,{cache:'no-store'})).arrayBuffer(); return { ms: performance.now()-t0, bytes: b.byteLength }; };
window.benchExtractTarZst = async (url, runs=${runs}) => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const times=[]; let fileCount=0, maxBuffered=0;
  for (let i=0;i<runs;i++){ const files=new Map(); const php={ mkdirTree(){}, writeFile(p,d){files.set(p,d);}, fileExists(){return false;} };
    const t0=performance.now(); const stream=await createDecodedTarStream(bytes,'zstd'); const stats=await extractTarStreamToPhp(stream,php,'/wp');
    times.push(performance.now()-t0); fileCount=stats.fileCount; maxBuffered=Math.max(maxBuffered,stats.maxBuffered); }
  return { medianMs: median(times), fileCount, maxBufferedMiB: maxBuffered/1048576 };
};
window.benchReady = true;
`
	);
	const out = path.join(tmp, 'bench.js');
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		outfile: out,
	});
	return { tmp, bench: readFileSync(out) };
}

function serve(benchJs, assets) {
	const html =
		'<!doctype html><meta charset=utf-8><script type=module src=/bench.js></script>';
	const server = http.createServer((req, res) => {
		const url = req.url.split('?')[0];
		if (url === '/' || url === '/index.html') {
			res.setHeader('content-type', 'text/html');
			return res.end(html);
		}
		if (url === '/bench.js') {
			res.setHeader('content-type', 'text/javascript');
			return res.end(benchJs);
		}
		const name = url.replace('/assets/', '');
		if (assets[name]) {
			res.setHeader('content-type', 'application/octet-stream');
			return res.end(assets[name]);
		}
		res.statusCode = 404;
		res.end('nf');
	});
	return new Promise((r) =>
		server.listen(0, '127.0.0.1', () =>
			r({ server, port: server.address().port })
		)
	);
}

const MiB = (n) => +(n / 1048576).toFixed(2);

async function main() {
	const { versions, runs } = parseArgs(process.argv.slice(2));
	const assets = {};
	for (const v of versions) {
		const tar = path.join(WP_DIR, `wp-${v}.tar.zst`);
		if (!existsSync(tar)) {
			console.error(`skip ${v}: no wp-${v}.tar.zst`);
			continue;
		}
		assets[`wp-${v}.tar.zst`] = readFileSync(tar);
		const zip = path.join(WP_DIR, `wp-${v}.zip`);
		if (existsSync(zip)) assets[`wp-${v}.zip`] = readFileSync(zip);
	}
	const present = versions.filter((v) => assets[`wp-${v}.tar.zst`]);

	const { tmp, bench } = await bundleHarness(runs);
	const { server, port } = await serve(bench, assets);
	const base = `http://127.0.0.1:${port}`;
	try {
		console.log(`# tar.zst browser benchmark (median of ${runs})\n`);
		console.log('## In-browser tar.zst extraction (ms)\n');
		console.log('| WordPress | Chromium | Firefox | WebKit | Peak JS buffer |');
		console.log('|---|---:|---:|---:|---:|');
		const ext = {};
		for (const [engine, name] of [
			[chromium, 'Chromium'],
			[firefox, 'Firefox'],
			[webkit, 'WebKit'],
		]) {
			const browser = await engine.launch();
			const page = await browser.newPage();
			await page.goto(`${base}/index.html`);
			await page.waitForFunction('window.benchReady === true', { timeout: 30000 });
			for (const v of present) {
				const r = await page.evaluate(
					async ([u, n]) => window.benchExtractTarZst(u, n),
					[`${base}/assets/wp-${v}.tar.zst`, runs]
				);
				(ext[v] ??= {})[name] = r;
			}
			await browser.close();
		}
		for (const v of present) {
			const e = ext[v];
			console.log(
				`| ${v} | ${e.Chromium.medianMs.toFixed(0)} ms | ${e.Firefox.medianMs.toFixed(0)} ms | ` +
					`${e.WebKit.medianMs.toFixed(0)} ms | ${e.Chromium.maxBufferedMiB.toFixed(1)} MiB |`
			);
		}

		console.log('\n## Network-throttled download: ZIP vs tar.zst (Chromium)\n');
		console.log('| Link | WordPress | ZIP | tar.zst | Saved |');
		console.log('|---|---|---:|---:|---:|');
		const browser = await chromium.launch();
		for (const prof of PROFILES) {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(`${base}/index.html`);
			await page.waitForFunction('window.benchReady === true');
			const client = await context.newCDPSession(page);
			await client.send('Network.enable');
			await client.send('Network.emulateNetworkConditions', {
				offline: false,
				downloadThroughput: prof.bps,
				uploadThroughput: prof.bps,
				latency: prof.latency,
			});
			for (const v of present) {
				const hasZip = !!assets[`wp-${v}.zip`];
				const zip = hasZip
					? await page.evaluate(
							async (u) => window.benchDownload(u),
							`${base}/assets/wp-${v}.zip?x=${Math.round(prof.bps)}`
						)
					: null;
				const tar = await page.evaluate(
					async (u) => window.benchDownload(u),
					`${base}/assets/wp-${v}.tar.zst?x=${Math.round(prof.bps)}`
				);
				const saved = zip
					? `−${((zip.ms - tar.ms) / 1000).toFixed(2)} s (−${(((zip.ms - tar.ms) / zip.ms) * 100).toFixed(1)} %)`
					: 'n/a (no ZIP)';
				console.log(
					`| ${prof.name} | ${v} | ${zip ? (zip.ms / 1000).toFixed(2) + ' s' : 'n/a'} | ` +
						`${(tar.ms / 1000).toFixed(2)} s | ${saved} |`
				);
			}
			await context.close();
		}
		await browser.close();
	} finally {
		server.close();
		rmSync(tmp, { recursive: true, force: true });
	}
}

main();
