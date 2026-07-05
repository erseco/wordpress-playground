---
slug: /developers/architecture/wordpress-core-bundle
---

# WordPress core bundle (streaming `tar.zst`)

Playground ships each minified WordPress version as a **core bundle** that is fetched in the
browser and extracted into the PHP-WASM in-memory filesystem (MEMFS) before WordPress boots.

The core bundle is a single **solid `tar.zst`** (a zstd-compressed tar) that is extracted by
**streaming**, instead of a per-entry DEFLATE **ZIP** extracted by the PHP `ZipArchive`
extension.

## How it works

```
wp-<version>.tar.zst  (fetched)
  → zstddec (WASM) streaming decode      // no browser ships DecompressionStream("zstd")
  → decoded TAR byte stream
  → incremental USTAR / GNU-longlink parser
  → php.writeFile() into MEMFS, one entry at a time
```

The runtime module lives in
[`@wp-playground/wordpress`](https://github.com/WordPress/wordpress-playground/tree/trunk/packages/playground/wordpress/src/streaming-tar-extract.ts)
and exports `createDecodedTarStream`, `StreamingTarParser`, `extractTarStreamToPhp`, and
`sanitizeTarPath`. `unzipWordPress()` sniffs the first bytes of the bundle (zstd magic
`28 B5 2F FD` vs the ZIP `PK\x03\x04`) and routes to the streaming extractor or to the legacy
`ZipArchive` path.

## Why `tar.zst`

- **Smaller downloads.** A _solid_ zstd archive can deduplicate across files, which per-entry
  ZIP DEFLATE cannot. Measured reduction: **≈ −15 % for modern versions** (WP 6.4–7.0) and
  **−40 % for WP 6.3**.
- **Faster extraction.** Decoding + parsing in JS is **~2.5–2.8× faster** than PHP
  `ZipArchive` running inside WASM (measured in Node PHP-WASM; the PoC measured the same on
  Chrome/Firefox/Safari).
- **Bounded peak memory.** The full uncompressed tree (~36 MiB) is never materialized in JS;
  the parser holds only one entry at a time plus a ~128 KiB decode chunk.

### Why solid compression helps WordPress _less_ than larger PHP apps

Sibling Playground forks (Moodle, Nextcloud, …) saw −50…−64 % from the same change. WordPress
sees less (~−15 %) because a WordPress bundle is mostly _already-compressed_ assets (minified
JS/CSS, `woff2` fonts, WebP images) with little cross-file redundancy, and it even embeds an
already-zipped `wordpress-static.zip`. Solid compression shines when there are many similar,
uncompressed files; WordPress has few. The extraction speedup, however, is engine-wide and
substantial.

### Why `zstddec` is needed

No shipping browser exposes `DecompressionStream("zstd")`, so a small (~76 KiB) WASM zstd
decoder ([`zstddec`](https://www.npmjs.com/package/zstddec)) is bundled. Codecs browsers _do_
support (gzip/deflate/brotli) still use the native `DecompressionStream`.

### Why ZIP support stays

Only the **core boot bundle** moved to `tar.zst`. ZIP handling (via PHP `ZipArchive`) is
unchanged for everything else: plugin/theme installation, the `unzip` Blueprint step,
wordpress.org full releases (used by the CLI and custom-version boots), GitHub `master.zip`
nightly/trunk builds, the SQLite integration plugin, and the `wordpress-static.zip`
static-asset backfill. `unzipWordPress()` detects the format and picks the right path.

## Integrity

The bundle descriptor (`getWordPressModuleDetails(version)`) carries
`format`, `container`, `codec`, `url`, `size`, `sha256`, and `fileCount`. After streaming
extraction, the number of files written is checked against `fileCount`; a mismatch throws
(guards truncated/corrupt downloads). The streaming parser also fails loudly on a
truncated archive, and rejects unsafe entry paths (absolute, `..` traversal, backslash
traversal) and symlinks — see `sanitizeTarPath`.

## Rebuilding & verifying bundles

The canonical rebuild (`npm run rebuild:wordpress-builds`) runs the Docker minification and
then re-containers the result into `wp-<version>.tar.zst` (requires Node ≥ 22.15 for native
`node:zlib` zstd). To re-container the committed minified ZIPs directly, or to verify hashes:

```bash
# Re-container all committed minified ZIPs → deterministic tar.zst + refresh the descriptor
node packages/playground/wordpress-builds/build/build-tar-zst.mjs --all

# Verify every committed tar.zst matches the sha256/size recorded in the descriptor
node packages/playground/wordpress-builds/build/build-tar-zst.mjs --verify
```

## Benchmarks

```bash
# Size + JS streaming-extraction throughput + peak buffer (several versions, median of 5)
node packages/playground/wordpress-builds/build/benchmark-tar-zst.mjs --runs=5

# Real browsers (Playwright): tar.zst extraction across Chromium/Firefox/WebKit +
# network-throttled download of zip vs tar.zst (needs `npx playwright install`)
node packages/playground/wordpress-builds/build/benchmark-tar-zst-browser.mjs --runs=5
```

Measured locally: extraction **~2.5–2.8× faster** than PHP `ZipArchive`; on a real 8 Mbps link
the smaller bundle saves **~4 s of download per cold boot** (WP 6.9). The PHP-WASM extraction
comparison, per-engine browser numbers, and methodology are in
[`docs/streaming-tar-zst-core-bundle.md`](https://github.com/WordPress/wordpress-playground/blob/trunk/docs/streaming-tar-zst-core-bundle.md).

## Note on the PHP-WASM runtime

The PHP runtime itself is **not** a `tar.zst` candidate and is unchanged. It arrives as a
single uncompressed `.wasm` fetched via `WebAssembly.instantiateStreaming(fetch(...))`, which
stream-compiles the module during download. There is no Emscripten MEMFS `.data` preload
package, and wrapping the `.wasm` in `tar.zst` would defeat streaming compilation. Runtime
transfer compression is better handled by server-side `Content-Encoding` (Brotli/zstd).
