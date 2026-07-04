#!/usr/bin/env node
//
// build-tar-zst-from-zip.mjs — re-container a `wordpress-static.zip` into a
// deterministic, zstd-compressed tar (`.tar.zst`) that the browser runtime can
// extract by streaming (see streaming-tar-extract.mjs). Proposal PoC — see
// README.md.
//
// Deterministic USTAR + GNU longlink (never PAX — the streaming parser and PHP
// readers do not honor PAX 'path' headers). zstd level 19 + long-distance
// matching (windowLog 27) for strong cross-file dedup. Requires Node >= 22.15
// (native node:zlib zstd).
//
//   npm i fflate
//   node build-tar-zst-from-zip.mjs wordpress-static.zip wordpress-static.tar.zst

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { unzipSync } from "fflate";
import { createUstarTar, normalizeEntries } from "./tar-ustar.mjs";

if (typeof zlib.zstdCompressSync !== "function") {
  console.error("Node >= 22.15 (native node:zlib zstd) is required.");
  process.exit(1);
}

const [inZip, outTarZst] = process.argv.slice(2);
if (!inZip || !outTarZst) {
  console.error("Usage: build-tar-zst-from-zip.mjs <in.zip> <out.tar.zst>");
  process.exit(1);
}

const fileMap = unzipSync(readFileSync(inZip));
const entries = normalizeEntries(fileMap);
const uncompressedBytes = entries.reduce((n, e) => n + e.data.length, 0);
const tar = createUstarTar(entries, { mtime: 0 });
const compressed = zlib.zstdCompressSync(tar, {
  params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 19,
    [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
    [zlib.constants.ZSTD_c_windowLog]: 27,
  },
});
writeFileSync(outTarZst, compressed);
console.log(
  JSON.stringify({
    fileCount: entries.length,
    bytes: compressed.length,
    sha256: createHash("sha256").update(compressed).digest("hex"),
    uncompressedBytes,
  }),
);
