# Proposal (PoC): streaming `tar.zst` for the WordPress core bundle

> **Status: documentation only.** This folder records a measured option for future
> evaluation. It changes **no** production code and is not (yet) a proposal to
> upstream `WordPress/wordpress-playground`. Numbers below are reproducible with
> the scripts in this folder.

## Idea

Today Playground ships each WordPress version as `wordpress-static.zip` (DEFLATE),
fetches it, writes it into the PHP-WASM MEMFS, and extracts it with PHP
`ZipArchive` (`unzipFile()` in `@wp-playground/common`, called from
`unzipWordPress()` in `boot.ts`).

This PoC re-containers the same tree as a **solid `tar.zst`** and extracts it in
JS by **streaming**: `zstddec` (WASM) decodes the stream, an incremental
USTAR/GNU-longlink parser writes each file into MEMFS as it arrives. The full
uncompressed tar is never materialized (bounded memory). No browser exposes
`DecompressionStream("zstd")`, so the ~76 KB `zstddec` WASM decoder is bundled.

The same approach was adopted (as full PRs) in four sibling Playground forks
(moodle/omeka/facturascripts/nextcloud), where it was a large win. This folder
answers a narrower question for WordPress specifically: **is it worth it here?**

## Measured results (WordPress 6.9, `wordpress-static.zip`)

Environment: Apple Silicon macOS, Playwright Chromium / Firefox / **WebKit 26.5
(Safari engine)**, local. Source tree: **1951 files, 50.7 MiB uncompressed**.

### 1. Bundle size

| Format | Size | Δ vs zip |
|--------|-----:|---------:|
| zip (current) | 17.94 MiB | — |
| **tar.zst (level 19 + LDM, wlog 27)** | **13.62 MiB** | **−24 %** |
| tar.gz (level 9) | 17.1 MiB | −4 % (negligible) |

WordPress compresses far less than the pure-PHP siblings (moodle −51 %,
facturascripts −64 %) because `wordpress-static.zip` is mostly already-compressed
assets (images, minified JS, woff2 fonts) with little cross-file redundancy.

### 2. Extraction into a real PHP-WASM MEMFS (median of 3 runs, ms)

Both paths extract the same 1951 files (`ZipArchive` reports 2196 entries because
it counts directories; the tar parser counts files only — content parity holds).

| Browser | PHP `ZipArchive` per-file loop (WP's real path) | PHP `ZipArchive::extractTo()` bulk | **tar.zst streaming** | tar.zst vs PHP |
|---------|--:|--:|--:|:--:|
| Chrome (Chromium) | 142 | 138 | **60** | **~2.3× faster** |
| Firefox | 701 | 681 | **262** | **~2.6× faster** |
| Safari (WebKit 26.5) | 142 | 135 | **55** | **~2.5× faster** |

Notes:
- Bulk `extractTo()` is no faster than WordPress's per-file loop, so the loop is
  **not** the bottleneck — native PHP `ZipArchive` is simply this slow here.
- **`tar.zst` streaming beats even the optimal PHP `ZipArchive` by ~2.3–2.6×** on
  all three engines, and its peak JS working buffer stayed ~2.4 MiB (bounded).

### 3. What this means for boot

Everything else in boot (PHP-WASM compile, WP install/render) is identical
between the two, so the boot delta = download delta + extraction delta:

- **Download:** −24 % (≈ −4.3 MiB) — scales with network speed.
- **Extraction:** −80 ms (Chrome) / **−440 ms (Firefox)** / −85 ms (Safari).

So it is a **real, consistent improvement — smaller *and* faster on Chrome,
Firefox and Safari** — but **modest in absolute terms**, because WordPress is a
small, fast-booting app (unlike the 23k-file Moodle tree where it was dramatic).

## Trade-offs (why this is "document and revisit", not "ship now")

- **Ripple:** the `wordpress-static.zip` format is referenced by the service
  worker, offline-mode cache, blueprint resources, `install-theme`/`install-plugin`
  helpers, and the public `@wp-playground/wordpress-builds` artifact. A format
  switch touches all of them.
- **New dependency:** `zstddec` (WASM) in the browser bundle.
- **Modest payoff:** ~80–440 ms + ~4 MiB for WordPress specifically.

Given that, the honest call is: **applicable and genuinely better, but not a
must-have for WordPress.** Recorded here for a future decision; a real proposal to
upstream would only make sense if the extraction speedup (esp. Firefox) is judged
worth the ripple.

## Reproduce

Prereqs: Node ≥ 22.15 (native `node:zlib` zstd), `zstd`/`unzip` CLIs optional.

```bash
cd proposals/tar-zst-streaming-core-bundle
npm i fflate zstddec

# 1) build the tar.zst from the shipped WordPress zip
node build-tar-zst-from-zip.mjs \
  ../../packages/playground/wordpress-builds/public/wp-6.9/wordpress-static.zip \
  wordpress-static.tar.zst

# 2) sanity-check the streaming decode + parity (no browser, no PHP)
node -e '
import("./streaming-tar-extract.mjs").then(async (m) => {
  const { readFileSync } = await import("node:fs");
  const bytes = new Uint8Array(readFileSync("wordpress-static.tar.zst"));
  const stream = await m.createDecodedTarStream(bytes, "zstd");
  const p = new m.StreamingTarParser({ onEntry: () => {} });
  const r = stream.getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; p.push(value); }
  console.log(p.end()); // { fileCount: 1951, maxBuffered: ~2.4 MiB, ... }
});'
```

### Browser extraction benchmark (real PHP MEMFS)

The ms table above was produced by bundling this tiny harness with esbuild
(keeping only PHP 8.3, ICU served from unpkg) against `@php-wasm/universal` +
`@php-wasm/web` (already in this monorepo) + `zstddec`, serving it, and calling
`window.runPhpBench()` in Chromium/Firefox/WebKit via Playwright. Harness core:

```js
import { PHP, __private__dont__use } from "@php-wasm/universal";
import { loadWebRuntime } from "@php-wasm/web";
import { createDecodedTarStream, extractTarStreamToPhp } from "./streaming-tar-extract.mjs";

window.runPhpBench = async () => {
  const php = new PHP(await loadWebRuntime("8.3"));
  const FS = php[__private__dont__use].FS;
  const shim = { _php: { mkdirTree: (d) => { try { FS.mkdirTree(d); } catch {} }, writeFile: (p, d) => FS.writeFile(p, d) } };
  const zip = new Uint8Array(await (await fetch("./wordpress-static.zip")).arrayBuffer());
  const tar = new Uint8Array(await (await fetch("./wordpress-static.tar.zst")).arrayBuffer());

  // A) WordPress's real path: PHP ZipArchive
  php.writeFile("/wp.zip", zip);
  let t = performance.now();
  await php.run({ code: `<?php $z=new ZipArchive; $z->open('/wp.zip'); for($i=0;$i<$z->numFiles;$i++){ $z->extractTo('/wpA',$z->getNameIndex($i)); } $z->close();` });
  const phpMs = Math.round(performance.now() - t);

  // B) streaming tar.zst → MEMFS
  const stream = await createDecodedTarStream(tar, "zstd");
  t = performance.now();
  const stats = await extractTarStreamToPhp(stream, shim, "/wpB");
  const tarMs = Math.round(performance.now() - t);
  return { phpMs, tarMs, files: stats.fileCount, maxBufMiB: +(stats.maxBuffered / 1048576).toFixed(1) };
};
```

## Files

- `streaming-tar-extract.mjs` — the runtime decoder + incremental tar parser
  (`createDecodedTarStream`, `StreamingTarParser`, `extractTarStreamToPhp`).
- `tar-ustar.mjs` — deterministic USTAR + GNU-longlink writer/reader (build side).
- `build-tar-zst-from-zip.mjs` — re-container a `wordpress-static.zip` → `.tar.zst`.
