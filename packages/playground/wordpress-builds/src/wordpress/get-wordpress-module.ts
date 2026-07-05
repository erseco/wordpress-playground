import { getWordPressModuleDetails } from './get-wordpress-module-details';

export async function getWordPressModule(wpVersion = '6.8'): Promise<File> {
	const details = getWordPressModuleDetails(wpVersion);
	const url = details.url;
	let data = null;
	if (url.startsWith('/')) {
		let path = url;
		if (path.startsWith('/@fs/')) {
			path = path.slice(4);
		}

		const { readFile } = await import('node:fs/promises');
		data = await readFile(path);
	} else {
		const response = await fetch(url);
		// We use .arrayBuffer() and not .blob() here because blob() throws when the
		// client is low on disk space. Blobs tend to be stored as temporary files,
		// array buffers tend to be stored in memory.
		// @see https://github.com/WordPress/wordpress-playground/issues/2769
		data = await response.arrayBuffer();
	}
	// The minified Playground bundle is a solid `tar.zst`; remote versions
	// (trunk/nightly) are a GitHub `master.zip`. The extractor sniffs the magic
	// bytes, so the filename/type here are only cosmetic.
	const isTarZst = details.format === 'tar.zst';
	return new File(
		[data as any],
		`${wpVersion || 'wp'}.${isTarZst ? 'tar.zst' : 'zip'}`,
		{ type: isTarZst ? 'application/zstd' : 'application/zip' }
	);
}
