---
slug: /developers/architecture/wordpress-core-bundle-tar-zst-design
---

# WordPress core bundle `tar.zst`: design notes & benchmarks

Design record and measured data for switching the WordPress **core boot bundle** from a
per-entry DEFLATE ZIP (extracted with PHP `ZipArchive`) to a single solid **`tar.zst`**
extracted by streaming. For the user-facing overview see
[WordPress core bundle](/developers/architecture/wordpress-core-bundle). Adapted for
`wordpress-playground` from the measured PoC in
[`erseco/wordpress-playground#2`](https://github.com/erseco/wordpress-playground/pull/2) and
the full implementation in
[`ateeducacion/omeka-s-playground#114`](https://github.com/ateeducacion/omeka-s-playground/pull/114).

## 1. Problem statement

WordPress Playground ships each minified WordPress version as a per-entry DEFLATE
**ZIP** (`packages/playground/wordpress-builds/src/wordpress/wp-<version>.zip`). At boot the
browser fetches that ZIP, writes it into the PHP-WASM MEMFS, and extracts it with the
PHP `ZipArchive` extension (`unzipFile()` in `@wp-playground/common`, called from
`unzipWordPress()` in `@wp-playground/wordpress`).

Two costs follow from this:

1. **Extraction is slow.** PHP `ZipArchive` runs _inside_ WASM. The PoC measured core
   extraction into a real PHP-WASM MEMFS at 142 ms (Chrome), **701 ms (Firefox)**, 142 ms
   (Safari/WebKit) for WordPress 6.9 — the single slowest non-compile step of a cold boot
   on Firefox.
2. **Peak JS memory.** The compressed ZIP is materialized as a `File`/`ArrayBuffer` and
   handed to PHP, which then holds the decompressed tree — no bounded-memory streaming.

Per-entry ZIP DEFLATE also cannot deduplicate across files, so the download is larger than
a solid archive of the same tree.

## 2. Current ZIP-based WordPress core bundle flow

```
build/build.js (Docker)  ──►  src/wordpress/wp-<v>.zip  (git-tracked, export-ignore)
                              + auto-generated get-wordpress-module-details.ts  { size, url }

Browser boot (packages/playground/remote):
  playground-worker-endpoint-blueprints-v1.ts
    getWordPressModuleDetails(v).url            → hashed vite ?url asset
    downloadMonitor.monitorFetch(fetch(url))    → Response
    → new File([arrayBuffer], 'wp.bundle')      → BootWordPressOptions.wordPressZip
  bootWordPress()                               (packages/playground/wordpress/src/boot.ts)
    → unzipWordPress(php, wpZip)                (packages/playground/wordpress/src/index.ts)
        → unzipFile(php, wpZip, '/tmp/unzipped-wordpress')   → PHP ZipArchive  (common)
        → nested-zip unwrap + subdir detection + moveRecursively → documentRoot
        → copy wp-config-sample.php → wp-config.php
```

**Important distinctions found during investigation (do not conflate):**

- The **core boot bundle** is `src/wordpress/wp-<v>.zip` (the _full_ WordPress tree, 1818
  files / ~36 MiB uncompressed for 6.9). This is the artifact this change replaces.
- `public/wp-<v>/wordpress-static.zip` is a **different** artifact — the static-asset
  _backfill_ bundle for offline/minified builds (CSS/JS/images stripped from the minified
  build), fetched post-boot by `backfillStaticFilesRemovedFromMinifiedBuild()`
  (`remote/src/lib/worker-utils.ts`) and served/cached by the service worker. It is **out
  of scope** here (see §4 Non-goals).
- The **CLI** (`packages/playground/cli`) does **not** use the minified bundle. It resolves a
  _full_ release from wordpress.org via `resolveWordPressRelease()` and downloads a real
  ZIP, then extracts it through the _same_ `unzipWordPress()`. Custom-URL and
  `wordpress.org` dotted-version browser paths also pass real ZIPs. Therefore
  `unzipWordPress()` must keep handling ZIP.

## 3. Proposed `tar.zst` flow

Re-container each minified `wp-<v>.zip` as a single **solid `tar.zst`**
(`wp-<v>.tar.zst`) and extract it in the browser by **streaming**:

```
compressed bytes  →  zstddec (WASM streaming decode)  →  decoded TAR byte stream
                  →  incremental USTAR / GNU-longlink parser  →  php.writeFile() into MEMFS
```

The full uncompressed tar is **never** materialized: at any instant the parser holds only a
partial 512-byte header, the current entry's bytes, and one decoded chunk (a few MiB). No
browser ships `DecompressionStream("zstd")`, so the ~76 KB `zstddec` WASM decoder is bundled;
`DecompressionStream` is still used for codecs browsers do support (gzip/deflate/brotli).

`unzipWordPress(php, wpZip)` becomes **format-sniffing**: it reads the first 4 bytes of the
bundle and routes:

- **zstd magic** `28 B5 2F FD` → streaming `tar.zst` extraction into `/tmp/unzipped-wordpress`,
  then the existing post-processing (subdir detection + `moveRecursively` + wp-config copy) is
  reused unchanged.
- **ZIP magic** `50 4B 03 04` (`PK\x03\x04`) → the existing PHP `ZipArchive` path, unchanged.

This keeps a single entry point, boots the minified bundle from streaming `tar.zst`, and
leaves every ZIP-consuming path (CLI, wordpress.org releases, custom URLs, API consumers,
nightly/trunk GitHub `master.zip`) working with no change.

### Chosen codec parameters

`node:zlib` zstd, level 19 + long-distance matching, **`windowLog` 25 (32 MiB)**. For these
≤ 40 MiB bundles that yields the same compression as `windowLog 27`, but with a bounded
multi-segment sliding window instead of the single-segment whole-content buffer that
`windowLog ≥ 26` forces on the decoder. `windowLog 24` (16 MiB) costs +1.7 MiB (+8 %) for 6.9.

### Descriptor (manifest) changes

`getWordPressModuleDetails(v)` is extended from `{ size, url }` to:

```ts
{
  format: 'tar.zst' | 'zip',   // 'zip' retained for remote nightly/trunk (GitHub master.zip)
  container: 'tar',            // present for tar.zst
  codec: 'zstd',               // present for tar.zst
  url: string,
  size: number,               // compressed byte length
  sha256: string,             // of the compressed artifact
  fileCount: number,          // regular-file count (for extraction parity)
}
```

Existing consumers reading `.size`/`.url` keep working. `format`/`container`/`codec` default
to the ZIP semantics when absent, so nightly/trunk (remote GitHub ZIP, no local metadata)
degrade cleanly.

## 4. Non-goals

- **`wordpress-static.zip` static-asset backfill** is not converted. It is a separate,
  post-boot, offline-only optimization with skip-existing (`overwriteFiles=false`) semantics,
  its own service-worker caching, and its own Docker build step. Converting it is a natural
  follow-up but is out of scope to keep the blast radius bounded. Documented in §Future work.
- **PHP runtime packaging** is not changed (see §10 — it is not a `tar.zst` candidate).
- **Plugin / theme / user-provided ZIP installation** (`installPlugin`, `installTheme`, the
  `unzip` blueprint step, `set-site-language`, the SQLite integration plugin ZIP) is
  unchanged. `unzipFile()` / PHP `ZipArchive` stay for all of these.
- No change to the WordPress install wizard, SQLite, blueprint semantics, or the boot
  sequence beyond the extraction mechanism.

## 5. Compatibility considerations

- **`unzipWordPress()` stays ZIP-capable** via byte sniffing — CLI, wordpress.org releases,
  custom URLs, nightly/trunk, and arbitrary API-supplied ZIPs are unaffected.
- **Node + browser parity.** The streaming extractor uses `zstddec` (WASM) which runs in both
  Node (vitest) and browsers; Node lacks `DecompressionStream("zstd")` (verified) so the
  `zstddec` fallback path is exercised by the test suite.
- **`getWordPressModule()`** (test-only helper) returns the `tar.zst` bytes as a `File`, so the
  existing blueprints/wordpress/sync spec suites boot from `tar.zst` automatically.
- **Downstream consumers** (Telex, Studio, wp-env) that read `getWordPressModuleDetails().size`
  / `.url` keep working; the added descriptor fields are additive. **Breaking change:** the
  core bundle artifact name/format changes (`wp-<v>.zip` → `wp-<v>.tar.zst`) and any consumer
  that hard-codes the `.zip` asset name or assumes PHP-`ZipArchive` extraction of the core
  bundle must adapt.
- **Service worker / offline cache.** The core bundle is a hashed vite `?url` asset cached
  on-demand (cache-first), keyed by `buildVersion` (= git HEAD). Switching the asset extension
  to `.tar.zst` requires `assetsInclude` to accept `*.tar.zst`; cache invalidation happens
  automatically on the new commit's `buildVersion`. The offline precache manifest excludes the
  hashed core-bundle `.zst` assets (vite emits `wp-<v>.tar-<hash>.zst`) so they stay cached
  on-demand, not eagerly precached.

## 6. Security requirements

The streaming extractor must be safe against archive traversal ("tar-slip") and fail closed:

- Reject **absolute** entry paths (`/etc/...`).
- Reject `..` path segments (traversal) after separator normalization.
- Normalize backslashes `\` → `/` before validation (Windows-style traversal).
- Skip empty / `.`-only names.
- **Symlinks and all non-regular, non-directory entry types are rejected/ignored** (WordPress
  core bundles contain none). USTAR typeflags handled: `0`/`\0` (file), `5` (dir), `L`
  (GNU longlink); everything else is skipped.
- **Fail loudly on malformed / truncated archives** (half-read entry at stream end throws).
- **File-count parity:** the number of regular files extracted is checked against
  `descriptor.fileCount`; a mismatch throws (guards truncated/corrupt downloads). Skipped only
  when no expected count is available (e.g. a non-descriptor ZIP path).
- Build-side path sanitization mirrors the runtime rules so a bundle can never _carry_ an
  unsafe entry in the first place.

## 7. Benchmark methodology

Reproducible via `packages/playground/wordpress-builds/build/benchmark-tar-zst.mjs` (size +
JS throughput) and `build/benchmark-tar-zst-browser.mjs` (real browsers).

- **Versions:** the latest bundled (7.0), the previous two minors (6.9, 6.8), and the oldest
  bundled (6.3). `beta` and `nightly`/`trunk` are excluded from size/extraction comparison
  (beta tracks 7.0; nightly is a remote GitHub ZIP with no local bundle).
- **Bundle size:** committed `wp-<v>.zip` size vs generated `wp-<v>.tar.zst` size; report MiB
  and %.
- **File count:** regular-file count per bundle.
- **Extraction time (real PHP-WASM MEMFS):** median of **5 runs** of (a) PHP `ZipArchive`
  per-file loop (current path) and (b) streaming `tar.zst`.
- **Browser (Playwright):** in-browser `tar.zst` JS extraction across Chromium/Firefox/WebKit,
  and Chromium DevTools network-throttled download of ZIP vs `tar.zst`.
- **Environment recorded below and in the PR body:** hardware, OS, Node version, browser
  versions, cache state, run count.

Numbers are never fabricated; anything not measured is labelled `pending preview`.

### Measured results (local)

Environment: Apple Silicon macOS (Darwin 25.4.0), Node v26.4.0, cold in-process runs.

**Bundle size (committed ZIP vs generated `tar.zst`, `windowLog` 25):**

| WordPress |       ZIP |   tar.zst |      Size Δ | Files |
| --------- | --------: | --------: | ----------: | ----: |
| 6.3       |  3.43 MiB |  2.07 MiB | **−39.6 %** |  1253 |
| 6.8       | 23.61 MiB | 19.88 MiB | **−15.8 %** |  1535 |
| 6.9       | 23.64 MiB | 19.87 MiB | **−15.9 %** |  1595 |
| 7.0       | 26.61 MiB | 22.58 MiB | **−15.2 %** |  1816 |

(6.4–6.6 ≈ −15.4…−15.6 %; beta ≈ −15.2 %.)

**Extraction into a real PHP-WASM MEMFS (Node `@php-wasm/node`, PHP 8.3, median of 5):**

| WordPress | PHP `ZipArchive` | streaming `tar.zst` |   Speedup |
| --------- | ---------------: | ------------------: | --------: |
| 6.3       |            63 ms |               22 ms | **2.82×** |
| 6.8       |            91 ms |               33 ms | **2.78×** |
| 6.9       |            98 ms |               39 ms | **2.51×** |
| 7.0       |           106 ms |               39 ms | **2.72×** |

This matches the PoC's real browser measurements for 6.9 (Chrome 142→60 ms ≈ 2.3×,
**Firefox 701→262 ms ≈ 2.6×**, Safari/WebKit 142→55 ms ≈ 2.5×).

**Real browser measurements (Playwright: Chromium / Firefox / WebKit 26.5).**
In-browser `tar.zst` extraction (zstddec streaming decode → `StreamingTarParser` → JS writes),
median of 5:

| WordPress | Chromium |    Firefox | WebKit | Peak JS buffer |
| --------- | -------: | ---------: | -----: | -------------: |
| 6.9       |    26 ms | **116 ms** |  25 ms |       18.0 MiB |
| 7.0       |    28 ms | **129 ms** |  25 ms |       20.4 MiB |

Firefox's JS decode is ~4.5× slower than Chromium/WebKit — the same engine gap the PoC saw for
PHP `ZipArchive`, so Firefox benefits most. The ~18 MiB peak is dominated by a single ~17.9 MiB
`wordpress-static.zip` file _embedded inside_ the core bundle (the largest entry); the parser
holds only one entry at a time, so the peak is bounded by the largest file, not the ~36 MiB
uncompressed tree.

**Real network-throttled download** (Chromium DevTools `Network.emulateNetworkConditions`),
`wp-<v>.zip` vs `wp-<v>.tar.zst` — the slow-link benefit:

| Link                | WordPress |     ZIP | tar.zst |                 Saved |
| ------------------- | --------- | ------: | ------: | --------------------: |
| 40 Mbps (broadband) | 6.9       |  4.99 s |  4.20 s | **−0.79 s (−15.8 %)** |
| 40 Mbps (broadband) | 7.0       |  5.61 s |  4.77 s |     −0.84 s (−14.9 %) |
| 8 Mbps (DSL / 4G)   | 6.9       | 24.85 s | 20.92 s | **−3.93 s (−15.8 %)** |
| 8 Mbps (DSL / 4G)   | 7.0       | 27.98 s | 23.76 s |     −4.22 s (−15.1 %) |

On a real 8 Mbps link the smaller bundle alone saves **~4 seconds of download per cold boot**,
on top of the ~2.5–2.8× faster extraction. The download saving dominates on slow links.

**Still pending preview:** the full end-to-end per-engine _app-ready_ time (booting the whole
Playground site: download + extract + WASM compile + WP install) — its two variable components
(download and extraction) are both measured in real browsers above; the composite awaits a
deployed preview build.

## 8. Test plan

Unit suite `streaming-tar-extract.spec.ts` (vitest, in `@wp-playground/wordpress`) covers:
normal/nested/empty-dir entries; GNU `././@LongLink` + USTAR `prefix`/`name` long paths;
headers and file bodies split across chunk boundaries; EOF + padding; truncation detection;
path-traversal / absolute-path / backslash rejection; symlink / exotic-typeflag rejection;
file-count parity; bounded `maxBuffered`; and a real `zstddec` round-trip asserting byte-for-byte
content + file-count parity.

Existing integration coverage is reused: the blueprints/wordpress/sync spec suites call
`getWordPressModule()` → `bootWordPress({ wordPressZip })`, which — once `getWordPressModule()`
returns `tar.zst` — boots a real WordPress from streaming `tar.zst` end to end.
`wordpress-zip-assets.spec.ts` (the view-transitions CSS regression guard) reads the `tar.zst`
bundles (zstd decode + USTAR parse).

## 9. Rollback considerations

- The switch is confined to (a) the build artifact + generated descriptor, (b)
  `unzipWordPress()` sniffing, (c) the new streaming module, (d) `assetsInclude` + offline
  precache exclusion, (e) the `zstddec` dependency.
- Because `unzipWordPress()` **sniffs bytes**, reverting is safe and incremental: restoring the
  `wp-<v>.zip` artifacts and repointing the descriptor's `url`/`format` back to `.zip`
  immediately returns the ZIP path with no other code change. The ZIP extractor code is not
  deleted (still used by plugin/theme/CLI/remote-release paths), so no code must be resurrected.
- `buildVersion`-keyed SW caching guarantees clients pick up the format change on deploy and
  purge stale caches on `activate`.

## 10. PHP runtime packaging investigation (actual findings — not a guess)

Traced end to end. The PHP-WASM runtime is **not** a `tar.zst` candidate:

- **How the bytes arrive (web):** `loadWebRuntime` (`php-wasm/web/src/lib/load-runtime.ts`) →
  `getPHPLoaderModule` → dynamic `import('@php-wasm/web-8-3')` → the version package
  (`php-wasm/web-builds/8-3/src/index.ts`) dynamically imports `asyncify|jspi/php_8_3.js`
  (Emscripten glue) → glue line 1 `import dependencyFilename from './…/php_8_3.wasm'` is turned
  into a **hashed asset URL** by esbuild/vite's `file` loader (`web-builds/8-3/build.js`,
  `loader: { '.wasm': 'file' }`) → at runtime `loadPHPRuntime`
  (`php-wasm/universal/src/lib/load-php-runtime.ts`) calls the glue's `instantiateAsync()`,
  which does `WebAssembly.instantiateStreaming(fetch(url), imports)` with an `arrayBuffer()`
  fallback. **The runtime is a single, uncompressed `.wasm` fetched and stream-compiled.**
- **No Emscripten `.data` MEMFS preload package exists** for the PHP runtime (`find` over
  `web-builds`/`node-builds` for `*.data` is empty; the compile Dockerfile uses
  `EXPORT_NAME='PHPLoader'` with no `--preload-file` / `file_packager.py`). The long `.data`
  docstring in `load-php-runtime.ts` describes a legacy mechanism current builds do not use.
- **ICU** (`icu.dat`, ~30 MiB) lives in `@php-wasm/web`/`@php-wasm/node`, is loaded **only**
  when the `intl` extension is requested, and is staged manually into MEMFS — not an Emscripten
  package.
- **No in-repo precompression** (no `.gz`/`.br`/`.zst`, no compression vite plugin). The only
  serving hint, `remote/.htaccess`, just sets `AddType application/wasm .wasm`; transparent
  HTTP compression is left to the production server.

**Verdict:** wrapping the `.wasm` in `tar.zst` would **break** `WebAssembly.instantiateStreaming`
(stream-compile during download) and force a full decode-then-compile, and zstd-over-an-already
-stream-compiled binary yields little. It is **not local** (touches 8 web + 8 node version
packages and the Emscripten build), **not low-risk**, and **not worth it**. Recorded as
**Future work**: rely on server-side Brotli/zstd `Content-Encoding` for the `.wasm` instead.

## Future work

- Remove the **~18 MiB `wordpress-static.zip` embedded inside the core bundle** (redundant with
  `public/wp-<v>/wordpress-static.zip`). This is the single largest entry and would roughly
  **halve** the core download — a bigger win than the `tar.zst` re-container itself, and
  orthogonal to it.
- Convert the `wordpress-static.zip` static-asset backfill to streaming `tar.zst` (mirror this
  work, honor `overwriteFiles=false` as skip-existing, update SW cache keys/`shouldCacheUrl`).
- Emit the `tar.zst` natively from the Docker build (`build/Dockerfile`, tar the staged tree)
  so `rebuild:wordpress-builds` produces it without the re-container step.
- Server-side `Content-Encoding: zstd`/`br` for the `.wasm` runtime.

## How to rebuild / verify

```bash
# Re-container the minified ZIPs into deterministic tar.zst + refresh the descriptor (wlog 25)
node packages/playground/wordpress-builds/build/build-tar-zst.mjs --all
# Verify a bundle hash matches the descriptor
node packages/playground/wordpress-builds/build/build-tar-zst.mjs --verify

# Benchmarks
node packages/playground/wordpress-builds/build/benchmark-tar-zst.mjs --runs=5          # size + JS
node packages/playground/wordpress-builds/build/benchmark-tar-zst-browser.mjs --runs=5  # real browsers
```
