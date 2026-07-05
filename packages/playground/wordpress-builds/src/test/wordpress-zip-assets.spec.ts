import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
// eslint-disable-next-line @nx/enforce-module-boundaries -- in-package build helper
import { readUstarTar } from '../../build/lib/tar-ustar.mjs';

const wordpressBuildsDirectory = new URL('../wordpress/', import.meta.url);

describe('WordPress core bundle assets', () => {
	it('ships CSS files that WordPress core reads from PHP', async () => {
		const bundles = getWordPressBundleFiles();
		expect(
			bundles.length,
			'Expected at least one wp-*.tar.zst build artifact'
		).toBeGreaterThan(0);

		let bundlesWithViewTransitions = 0;

		for (const bundle of bundles) {
			const bundlePath = fileURLToPath(
				new URL(`../wordpress/${bundle}`, import.meta.url)
			);
			const files = listBundleFiles(bundlePath);

			if (!files.has('wp-includes/view-transitions.php')) {
				continue;
			}

			bundlesWithViewTransitions++;
			expect(files.has('wp-admin/css/view-transitions.css')).toBe(true);
			expect(files.has('wp-admin/css/view-transitions.min.css')).toBe(
				true
			);
		}

		expect(
			bundlesWithViewTransitions,
			'Expected at least one WordPress bundle with wp-includes/view-transitions.php'
		).toBeGreaterThan(0);
	});
});

function getWordPressBundleFiles() {
	return readdirSync(wordpressBuildsDirectory).filter((fileName) =>
		/^wp-.*\.tar\.zst$/.test(fileName)
	);
}

function listBundleFiles(bundlePath: string): Set<string> {
	const compressed = readFileSync(bundlePath);
	// node:zlib zstd (Node >= 22.15); cast because @types/node may predate it.
	const tar = (zlib as any).zstdDecompressSync(compressed) as Buffer;
	const entries = readUstarTar(tar) as Array<{ name: string }>;
	return new Set(entries.map((entry) => entry.name));
}
