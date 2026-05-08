import { Database } from 'jsr:@db/sqlite@0.13';
import { parseArgs } from 'jsr:@std/cli/parse-args';
import * as pathUtils from 'jsr:@std/path';

import * as utils from './utils.js';

// Parse command-line arguments
const args = parseArgs(Deno.args, {
	boolean: ['clean'],
	string: ['config'],
	default: {
		clean: false,
		config: 'config.json',
	},
});

// Load configuration
utils.loadConfig(args['config']);

// Load information about sources
const sources = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.inputPath, 'sources.json')));

// Get path of temporary build directory
const tempBuildPath = pathUtils.join(config.buildPath, '.temp');

// Often reused regular expressions
const linkExp = /((?:href|src|action|background|rectangle|http-equiv *= *"?refresh"?[^>]+content) *= *)("[^">]+"|[^ >]+)/gis;
const baseExp = /<base\s+h?ref *= *("[^">]+"|[^ >]+)/is;

// Do the build
(async function performBuild() {
	const startTime = Date.now();

	// Delete loose temporary files if they exist
	if (utils.getPathInfo(tempBuildPath)?.isDirectory) {
		utils.logMessage('deleting loose temp files...');
		Deno.removeSync(tempBuildPath, { recursive: true });
	}

	// Load index files, or build them if they don't exist
	const urlIndexPath = pathUtils.join(config.buildPath, 'url_index.json');
	const pathIndexPath = pathUtils.join(config.buildPath, 'path_index.json');
	const screenshotIndexPath = pathUtils.join(config.buildPath, 'screenshot_index.json');
	let urlIndex, pathIndex, screenshotIndex;
	if (!args['clean'] && [urlIndexPath, pathIndexPath, screenshotIndexPath].every(indexPath => utils.getPathInfo(indexPath)?.isFile)) {
		utils.logMessage('loading indexes...');
		urlIndex = JSON.parse(Deno.readTextFileSync(urlIndexPath));
		pathIndex = JSON.parse(Deno.readTextFileSync(pathIndexPath));
		screenshotIndex = JSON.parse(Deno.readTextFileSync(screenshotIndexPath));
	}
	else
		[urlIndex, pathIndex, screenshotIndex] = await buildIndexes();

	// Create the build and temporary directories if needed
	Deno.mkdirSync(tempBuildPath, { recursive: true });

	// Save indexes to files
	utils.logMessage('saving indexes...');
	Deno.writeTextFileSync(pathUtils.join(tempBuildPath, 'url_index.json'), JSON.stringify(urlIndex, null, '\t'));
	Deno.writeTextFileSync(pathUtils.join(tempBuildPath, 'path_index.json'), JSON.stringify(pathIndex, null, '\t'));
	Deno.writeTextFileSync(pathUtils.join(tempBuildPath, 'screenshot_index.json'), JSON.stringify(screenshotIndex, null, '\t'));

	// Save source information to file
	utils.logMessage('saving source information...')
	const sourcesPath = pathUtils.join(tempBuildPath, 'sources.json');
	Deno.writeTextFileSync(sourcesPath, JSON.stringify(sources, null, '\t'));

	// Initialize the new database
	utils.logMessage('creating new database...');
	const searchDatabase = new Database(pathUtils.join(tempBuildPath, 'search.sqlite'), { create: true });
	searchDatabase.exec('PRAGMA journal_mode = WAL');
	searchDatabase.exec('PRAGMA shrink_memory');
	searchDatabase.exec('CREATE VIRTUAL TABLE search USING FTS5 (source UNINDEXED, url, title, content, type UNINDEXED, orphan UNINDEXED)');
	searchDatabase.exec("INSERT INTO search (search, rank) VALUES ('rank', 'bm25(0, 1, 1000, 1000, 0, 0)')");
	const insertStatement = searchDatabase.prepare('INSERT INTO search (source, url, title, content, type, orphan) VALUES (?, ?, ?, ?, ?, ?)');

	// Initialize total entry statistics
	const stats = { total: { urls: 0, orphans: 0, screenshots: 0, errors: 0 } };
	for (const sourceId in sources)
		stats[sourceId] = { urls: 0, orphans: 0, screenshots: 0, errors: 0 };

	// Gather totals
	const urlTotal = Object.values(urlIndex).map(entries => entries.filter(entry => !entry.skip).length).reduce((sum, n) => sum + n, 0);
	const orphanTotal = Object.values(pathIndex).map(entries =>
		Object.values(entries).filter(entry => entry.sanitizedUrl === null && !entry.skip).length
	).reduce((sum, n) => sum + n, 0);
	const screenshotTotal = Object.values(screenshotIndex).map(entries => entries.length).reduce((sum, n) => sum + n, 0);

	// Build the URL file tree
	let urlCurrent = 0;
	for (const sanitizedUrl in urlIndex) {
		// Condense archive info
		const archives = [];
		const urlEntries = urlIndex[sanitizedUrl];
		for (const urlEntry of urlEntries) {
			if (!urlEntry.skip)
				archives.push({
					source: urlEntry.source,
					url: urlEntry.url,
					path: urlEntry.path,
					types: [urlEntry.type],
					warn: urlEntry.warn,
					error: urlEntry.error,
				});
		}

		// Don't proceed if there are no valid archives for the current URL
		if (archives.length == 0)
			continue;

		// Create the containing directory for the current URL
		const urlDir = utils.getArchiveRootDir(sanitizedUrl, 'urls', tempBuildPath);
		Deno.mkdirSync(urlDir, { recursive: true });

		// Create subdirectories for each archive of the current URL with file data and important information
		for (let i = 0; i < archives.length; i++) {
			const archive = archives[i];

			// Create subdirectory with the naming format <index>_<source>
			const targetDir = pathUtils.join(urlDir, i.toString().padStart(2, '0') + '_' + archive.source);
			Deno.mkdirSync(targetDir, { recursive: true });

			// Create the files
			utils.logMessage(`[${++urlCurrent}/${urlTotal}] building ${archive.source} archive for ${sanitizedUrl}...`);
			buildArchive(archive, urlIndex, pathIndex, targetDir, insertStatement);

			// Increment URL totals
			if (!archive.error) {
				stats[archive.source].urls++;
				stats.total.urls++;
			}
			else {
				stats[archive.source].errors++;
				stats.total.errors++;
			}
		}

		// Save archive info to a file
		const archivesPath = pathUtils.join(urlDir, 'archives.json');
		Deno.writeTextFileSync(archivesPath, JSON.stringify(archives, null, '\t'));
	}

	// Build the orphan file tree
	let orphanCurrent = 0;
	for (const sourceId in pathIndex) {
		for (const sanitizedPath in pathIndex[sourceId]) {
			const orphanEntry = pathIndex[sourceId][sanitizedPath];
			// Orphans do not have an associated URL, and we should only build archives of valid orphans
			if (orphanEntry.sanitizedUrl !== null || orphanEntry.skip)
				continue;

			// Gather orphan info
			const orphan = {
				source: sourceId,
				url: null,
				path: orphanEntry.path,
				types: [orphanEntry.type],
				warn: false,
				error: orphanEntry.error,
			};

			// Create a containing directory for the current orphan
			const targetDir = utils.getArchiveRootDir(pathUtils.join(orphan.source, sanitizedPath), 'orphans', tempBuildPath);
			Deno.mkdirSync(targetDir, { recursive: true });

			// Create the files
			utils.logMessage(`[${++orphanCurrent}/${orphanTotal}] building ${orphan.source} archive for ${sanitizedPath}...`);
			buildArchive(orphan, urlIndex, pathIndex, targetDir, insertStatement);

			// Increment orphan totals
			if (!orphan.error) {
				stats[orphan.source].orphans++;
				stats.total.orphans++;
			}
			else {
				stats[orphan.source].errors++;
				stats.total.errors++;
			}

			// Save orphan info to a file
			const orphanPath = pathUtils.join(targetDir, 'orphan.json');
			Deno.writeTextFileSync(orphanPath, JSON.stringify(orphan, null, '\t'));
		}
	}

	// Close the database since we don't need to add to it anymore
	searchDatabase.close();

	// Build the screenshot file tree
	let screenshotCurrent = 0;
	for (const sanitizedUrl in screenshotIndex) {
		const screenshots = screenshotIndex[sanitizedUrl];

		// Create the containing directory for the current URL
		const urlDir = utils.getArchiveRootDir(sanitizedUrl, 'screenshots', tempBuildPath);
		Deno.mkdirSync(urlDir, { recursive: true });

		// Create subdirectories for each screenshot of the current URL with file data and important information
		for (let i = 0; i < screenshots.length; i++) {
			const screenshot = screenshots[i];

			// Create subdirectory with the naming format <index>_<source>
			const targetDir = pathUtils.join(urlDir, i.toString().padStart(2, '0') + '_' + screenshot.source);
			Deno.mkdirSync(targetDir, { recursive: true });

			// Create the files
			utils.logMessage(`[${++screenshotCurrent}/${screenshotTotal}] building ${screenshot.source} screenshot for ${sanitizedUrl}...`);
			const sourcePath = pathUtils.join(config.inputPath, 'screenshots', screenshot.source, screenshot.path);
			const thumbnail = new Deno.Command('convert', { args: [sourcePath, '-geometry', 'x64', '-'], stdout: 'piped' }).outputSync().stdout;
			Deno.copyFileSync(sourcePath, pathUtils.join(targetDir, 'screenshot'));
			Deno.writeFileSync(pathUtils.join(targetDir, 'thumbnail'), thumbnail);

			// Increment screenshot totals
			stats[screenshot.source].screenshots++;
			stats.total.screenshots++;
		}

		// Save screenshot info to a file
		const screenshotsPath = pathUtils.join(urlDir, 'screenshots.json');
		Deno.writeTextFileSync(screenshotsPath, JSON.stringify(screenshots, null, '\t'));
	}

	// Save total entry statistics to file
	utils.logMessage('saving entry statistics...');
	const statsPath = pathUtils.join(tempBuildPath, 'stats.json');
	Deno.writeTextFileSync(statsPath, JSON.stringify(stats, null, '\t'));

	// Create a directory to store old build files for deletion
	const deleteBuildPath = pathUtils.join(config.buildPath, '.delete');
	Deno.mkdirSync(deleteBuildPath, { recursive: true });

	// Move old files to deletion directory and move new files out of temporary directory
	utils.logMessage('moving files out of temp directory...');
	const buildEntries = [
		'search.sqlite',
		'sources.json',
		'stats.json',
		'url_index.json',
		'path_index.json',
		'screenshot_index.json',
		'urls',
		'screenshots',
		'orphans',
		'inlinks_urls',
		'inlinks_orphans',
	];
	for (const buildEntry of buildEntries) {
		const buildEntryPath = pathUtils.join(config.buildPath, buildEntry);
		if (utils.getPathInfo(buildEntryPath) !== null) {
			const deleteBuildEntryPath = pathUtils.join(deleteBuildPath, buildEntry);
			Deno.renameSync(buildEntryPath, deleteBuildEntryPath);
		}
		const tempBuildEntryPath = pathUtils.join(tempBuildPath, buildEntry);
		if (utils.getPathInfo(tempBuildEntryPath))
			Deno.renameSync(tempBuildEntryPath, buildEntryPath);
	}
	Deno.removeSync(tempBuildPath);

	// Remove temporary/deletion directories
	utils.logMessage('deleting old build files...');
	Deno.removeSync(deleteBuildPath, { recursive: true });

	// We're done
	const timeElapsed = Date.now() - startTime;
	const secondsElapsed = Math.floor(timeElapsed / 1000);
	const minutesElapsed = Math.floor(secondsElapsed / 60);
	const hoursElapsed = Math.floor(minutesElapsed / 60);
	utils.logMessage(`finished in ${hoursElapsed} hours, ${minutesElapsed % 60} minutes, and ${secondsElapsed % 60} seconds`);
	Deno.exit();
})();

// Build URL/path/screenshot indexes to speed up the build process
async function buildIndexes() {
	utils.logMessage('building indexes...');

	// Gather totals
	let pathTotal = 0;
	let screenshotTotal = 0;
	for (const sourceId in sources) {
		const pathEntriesPath = pathUtils.join(config.inputPath, 'archives', sourceId + '.json');
		pathTotal += JSON.parse(Deno.readTextFileSync(pathEntriesPath)).length;
		const screenshotEntriesPath = pathUtils.join(config.inputPath, 'screenshots', sourceId + '.json');
		if (utils.getPathInfo(screenshotEntriesPath)?.isFile)
			screenshotTotal += JSON.parse(Deno.readTextFileSync(screenshotEntriesPath)).length;
	}

	const urlIndex = {};
	const pathIndex = {};
	let pathCurrent = 0;
	for (const sourceId in sources) {
		if (pathIndex[sourceId] === undefined)
			pathIndex[sourceId] = {};

		const entries = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.inputPath, 'archives', sourceId + '.json')));
		for (const entry of entries) {
			// Invalid entries are never rendered and thus don't need their type determined
			// Meanwhile, error entries are always HTML pages
			let type = null;
			if (!entry.skip) {
				if (!entry.error)
					type = await mimeType(pathUtils.join(config.inputPath, 'archives', sourceId, entry.path));
				else
					type = 'text/html';
			}

			// Get sanitized URL and add entry to URL index
			let sanitizedUrl = null;
			if (entry.url !== null) {
				sanitizedUrl = utils.sanitizeUrl(entry.url);
				if (urlIndex[sanitizedUrl] === undefined)
					urlIndex[sanitizedUrl] = [];

				urlIndex[sanitizedUrl].push({
					source: sourceId,
					url: entry.url,
					path: entry.path,
					type: type,
					warn: entry.warn,
					error: entry.error,
					skip: entry.skip,
				});
			}

			// Get sanitized path and add entry to path index
			// If it needs to be skipped but doesn't have a valid URL, then it's useless to us
			// (Unless the URL mode is 1, otherwise we need to know its path so we can mark it as invalid)
			if (!entry.skip || sanitizedUrl !== null || sources[sourceId].urlMode == 1)
				pathIndex[sourceId][utils.sanitizePath(entry.path, entry.skip)] = {
					sanitizedUrl: sanitizedUrl,
					path: entry.path,
					type: type,
					error: entry.error,
					skip: entry.skip,
				};

			utils.logMessage(`[${++pathCurrent}/${pathTotal}] added ${sourceId} archive entry: ${entry.url ?? entry.path}`);
		}
	}

	// Populate screenshot index
	const screenshotIndex = {};
	let screenshotCurrent = 0;
	for (const sourceId in sources) {
		// Not every source has screenshots
		const entriesPath = pathUtils.join(config.inputPath, 'screenshots', sourceId + '.json');
		if (!utils.getPathInfo(entriesPath)?.isFile)
			continue;

		const entries = JSON.parse(Deno.readTextFileSync(entriesPath));
		for (const entry of entries) {
			const sanitizedUrl = utils.sanitizeUrl(entry.url);
			if (screenshotIndex[sanitizedUrl] === undefined)
				screenshotIndex[sanitizedUrl] = [];

			screenshotIndex[sanitizedUrl].push({
				source: sourceId,
				url: entry.url,
				path: entry.path,
				type: entry.type,
			});

			utils.logMessage(`[${++screenshotCurrent}/${screenshotTotal}] added ${sourceId} screenshot entry: ${entry.url}`);
		}
	}

	return [urlIndex, pathIndex, screenshotIndex];
}

// Parse an entry's file data, then add to database and file tree
function buildArchive(archive, urlIndex, pathIndex, targetDir, insertStatement) {
	let search, doRaw = true;

	const sourcePath = pathUtils.join(config.inputPath, 'archives', archive.source, archive.path);
	const targetPath = pathUtils.join(targetDir, 'file');
	if (archive.types[0] == 'text/html') {
		// Load HTML file and try to revert source-specific modifications, then extract and resolve links and save
		// This process can be repeated up to two more times for different variations of the HTML content
		// (Namely, variations that attempt to fix non-standard/archaic markup with modern/legacy browsers in mind, respectively)
		const html = genericizeMarkup(getText(sourcePath, archive.source, archive.url), archive.source, archive.path, archive.url);
		const [newHtml, inject] = buildInjectAndInlinks(html, archive, urlIndex, pathIndex);
		Deno.writeTextFileSync(targetPath, newHtml);
		Deno.writeTextFileSync(pathUtils.join(targetDir, 'inject.json'), JSON.stringify(inject, null, '\t'));

		const html_p = improvePresentation(html);
		if (html != html_p) {
			const [newHtml_p, inject_p] = buildInjectAndInlinks(html_p, archive, urlIndex, pathIndex);
			Deno.writeTextFileSync(targetPath + '_p', newHtml_p);
			Deno.writeTextFileSync(pathUtils.join(targetDir, 'inject_p.json'), JSON.stringify(inject_p, null, '\t'));

			const html_pc = improvePresentation(html, true);
			if (html_p != html_pc) {
				const [newHtml_pc, inject_pc] = buildInjectAndInlinks(html_pc, archive, urlIndex, pathIndex);
				Deno.writeTextFileSync(targetPath + '_pc', newHtml_pc);
				Deno.writeTextFileSync(pathUtils.join(targetDir, 'inject_pc.json'), JSON.stringify(inject_pc, null, '\t'));
			}
		}

		// Build title/description text
		search = buildSearch(html, archive.types[0]);
	}
	else if (archive.source == 'roteiro') {
		// Novo Roteiro Pratico da Internet has header and footer HTML inserted in even non-text files
		const headerExp = /^<a name = \d+>\n/i;
		const footerExp = /(?:<hr>)?\n<h6>Internet URL-\n <a href=.*?>.*?<\/a> <\/h6>\n*$/;
		if (archive.types[0].startsWith('text/')) {
			// Remove header/footer HTML from text files, but convert them to UTF-8 first
			const text = getText(sourcePath, archive.source)
				.replace(headerExp, '')
				.replace(footerExp, '');
			Deno.writeTextFileSync(targetPath, text);
		}
		else {
			// Surgically remove header/footer HTML from the byte array of non-text files
			let file = Deno.readFileSync(sourcePath);
			let start = 0, end = 0;
			const text = new TextDecoder().decode(file);

			// Find indexes of where actual file contents start and end, excluding header/footer HTML
			const headerMatch = text.match(headerExp);
			if (headerMatch !== null) {
				const encodedText = new TextEncoder().encode(headerMatch[0]);
				start = encodedText.length;
			}
			const footerMatch = text.match(footerExp);
			if (footerMatch !== null) {
				const encodedText = new TextEncoder().encode(footerMatch[0]);
				end = file.length - encodedText.length;
			}

			// Shrink the array accordingly and write to file
			if (start > 0 || end > 0)
				file = file.subarray(start, end);
			Deno.writeFileSync(targetPath, file);
		}
	}
	else if (archive.types[0].startsWith('text/')) {
		// Convert text to UTF-8 and save
		const text = getText(sourcePath, archive.source, archive.url);
		Deno.writeTextFileSync(targetPath, text);

		// Build description text
		search = buildSearch(text, archive.types[0]);
	}
	else if (archive.types[0] == 'image/gif' && archive.source == 'riscdisc') {
		// Fix weirdly-formatted GIFs present in The Risc Disc Volume 2
		const data = new Deno.Command('convert', { args: [sourcePath, '+repage', '-'], stdout: 'piped' }).outputSync().stdout;
		Deno.writeFileSync(targetPath, data);
	}
	else {
		// We can just use the raw file data
		Deno.copyFileSync(sourcePath, targetPath);
		doRaw = false;

		if (archive.types[0] == 'image/x-xbitmap') {
			// Convert XBM to GIF for when presentation improvements are active
			const data_p = new Deno.Command('convert', { args: [sourcePath, 'GIF:-'], stdout: 'piped' }).outputSync().stdout;
			Deno.writeFileSync(targetPath + '_p', data_p);
			archive.types.push('image/gif');
		}
	}

	// Also copy over the raw file data if we're not already using it
	if (doRaw)
		Deno.copyFileSync(sourcePath, pathUtils.join(targetDir, 'raw'));

	// Add archive to database
	if (!archive.error)
		insertStatement.run(
			archive.source,
			archive.url ?? archive.path,
			search?.title || null,
			search?.content || null,
			archive.types[0],
			archive.url === null,
		);

	// We don't need to store the path anymore
	if (archive.url === null)
		archive.url = archive.path;
	delete archive.path;
}

// Extract links from HTML, resolve them, and use to build injection list and inlinks
function buildInjectAndInlinks(html, archive, urlIndex, pathIndex) {
	const inject = {
		styles: {
			index: -1,
		},
		navbar: {
			compat: {
				index: -1,
			},
			modern: {
				index: -1,
			}
		},
		frames: [],
		links: [],
	};
	const inlinkEntry = {
		source: archive.source,
		url: archive.url ?? archive.path,
	};

	let offset = 0;
	const source = sources[archive.source];
	const newHtml = html.replace(/<base .*?>(?:.*?<\/base>)?/gis, '').replace(linkExp, (match, tagStart, url, index) => {
		let rawUrl = encodeURI(utils.safeDecode(trimQuotes(url)));
		// Anchors and missing URLs should be left unchanged, but make sure they're at least surrounded by quotes
		if (rawUrl.startsWith('#') || rawUrl == '/deadend') {
			const newStr = tagStart + '"' + rawUrl + '"';
			offset += match.length - newStr.length;
			return newStr;
		}

		// Check for excess data in the URL string and remove it
		let urlPrefix = '';
		if (/^http-equiv/i.test(tagStart))
			urlPrefix = rawUrl.match(/^\d*;? *(?:URL=)?/i)[0];
		else if (/^rectangle/i.test(tagStart))
			urlPrefix = rawUrl.match(/^ *(?:\(\d+, *\d+\) *)*/)[0];
		rawUrl = rawUrl.substring(urlPrefix.length);

		const isAbsolute = /^[a-z]+:/i.test(rawUrl);
		let resolvedSource = null;
		let resolvedUrl = null;
		let absoluteUrl = rawUrl;
		let anchor = '';
		let isOrphan = false;
		let forceMissing = false;
		// Non-zero URL modes assume the link has been modified to point within the source's filesystem
		if (source.urlMode > 0 && !isAbsolute) {
			// Get absolute path and separate anchor if it exists
			const parsedPath = URL.parse(rawUrl, 'http://ignoreme/' + archive.path);
			if (parsedPath !== null) {
				absoluteUrl = parsedPath.pathname.substring(1);
				anchor = parsedPath.hash;
			}

			const pathEntries = pathIndex[archive.source];
			if (pathEntries !== undefined) {
				// Check if sanitized path exists in path index
				let sanitizedPath = utils.sanitizePath(absoluteUrl);
				let pathEntry = pathEntries[sanitizedPath];
				// If it doesn't, try again with the anchor included
				if (pathEntry === undefined && anchor != '') {
					sanitizedPath = utils.sanitizePath(absoluteUrl + anchor, true);
					pathEntry = pathEntries[sanitizedPath];
				}

				if (pathEntry !== undefined) {
					// We need to do this for Internet on a CD specifically, since its placeholder links rely on anchors
					if (pathEntry.skip)
						anchor = '';
					if (pathEntry.sanitizedUrl !== null) {
						// This entry has a valid URL, so fetch info from nearest source
						const urlEntries = urlIndex[pathEntry.sanitizedUrl];
						[resolvedSource, resolvedUrl] = nearestArchiveInfo(urlEntries, archive.source, sanitizedPath);
					}
					else {
						// This entry is an orphan
						resolvedSource = archive.source;
						resolvedUrl = pathEntry.path;
						isOrphan = true;
						forceMissing = source.urlMode == 1 && pathEntry.skip;
					}
				}
			}
		}

		if (resolvedUrl === null) {
			// Get absolute URL and separate anchor if it exists
			const parsedUrl = URL.parse(rawUrl, archive.url);
			if (parsedUrl !== null) {
				anchor = parsedUrl.hash;
				parsedUrl.hash = '';
				absoluteUrl = parsedUrl.href;
			}

			// Check if URL exists in the archive, and fetch info from nearest source if so
			const sanitizedUrl = utils.sanitizeUrl(absoluteUrl);
			const urlEntries = urlIndex[sanitizedUrl];
			if (urlEntries !== undefined)
				[resolvedSource, resolvedUrl] = nearestArchiveInfo(urlEntries, archive.source);
		}

		// Build replacement string that cuts out the URL to be re-inserted by the server
		let newStr = tagStart;
		if (forceMissing || (source.urlMode == 2 && resolvedUrl === null && !isAbsolute))
			// If the source's URL mode is 2, unresolved relative links are assumed to be invalid
			newStr += '"' + urlPrefix + '/deadend"';
		else {
			newStr += '"' + urlPrefix + '"';

			if (resolvedUrl !== null)
				resolvedUrl = encodeURI(resolvedUrl);

			// Push resolved link info to injection list
			const linkInject = {
				index: index - offset + tagStart.length + 1 + urlPrefix.length,
				source: resolvedSource,
				url: (resolvedUrl ?? absoluteUrl).replaceAll('#', '%23') + anchor,
				embed: !/^href/i.test(tagStart),
			};
			inject.links.push(linkInject);

			// Check if link is valid before adding to inlinks list
			const inlinkUrl = (resolvedUrl ?? absoluteUrl).replace(/(?<=^[^#]+)#[^#]+$/, '');
			if (resolvedSource !== null || (/^https?:/i.test(inlinkUrl) && URL.canParse(inlinkUrl))) {
				const sanitizedUrl = !isOrphan
					? utils.sanitizeUrl(inlinkUrl)
					: pathUtils.join(linkInject.source, utils.sanitizePath(inlinkUrl));

				// Don't bother with insanely long links because the OS may not be able to handle them
				const inlinksDir = utils.getArchiveRootDir(sanitizedUrl, 'inlinks_' + (isOrphan ? 'orphans' : 'urls'), tempBuildPath);
				if (inlinksDir.length < 256) {
					let inlinks = [];

					// Load inlinks list if it exists, otherwise prepare directory to write it into
					const inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
					if (!utils.getPathInfo(inlinksPath)?.isFile)
						Deno.mkdirSync(inlinksDir, { recursive: true });
					else
						inlinks = JSON.parse(Deno.readTextFileSync(inlinksPath));

					// Add to inlinks list if not a duplicate
					if (!inlinks.some(inlink => inlinkEntry.source == inlink.source && inlinkEntry.url == inlink.url)) {
						inlinks.push(inlinkEntry);
						inlinks.sort((a, b) => a.url.localeCompare(b.url, 'en', { sensitivity: 'base' }));
						Deno.writeTextFileSync(inlinksPath, JSON.stringify(inlinks, null, '\t'));
					}
				}
			}
		}

		// Update the offset for link indexes and return the replacement string
		offset += match.length - newStr.length;
		return newStr;
	});

	// Blank commented-out markup so it doesn't get caught by any of the below regex
	const newHtmlNoComments = newHtml.replace(/<! *-+.*?-+ *>/gs, match => ' '.repeat(match.length));

	// Find index at which stylesheets can be inserted
	const headExp = /<head(?:er)?(?:| .*?)>/i;
	const headMatch = newHtmlNoComments.match(headExp);
	inject.styles.index = headMatch !== null ? headMatch.index + headMatch[0].length : 0;

	// Find index at which compatibility mode navbar can be inserted
	const bodyOpenExp = /^(?:\s*(?:<(?:!DOCTYPE.*?|html|head(?:er)?.*?>.*?<\/head|body)>\s*)+)?/is;
	const bodyOpenMatch = newHtmlNoComments.match(bodyOpenExp);
	inject.navbar.compat.index = bodyOpenMatch !== null ? bodyOpenMatch[0].length : 0;

	// Find index at which modern mode navbar can be inserted
	const bodyCloseExp = /(?:(?:<\/(?:body|noframes|html)>\s*)+)?$/i;
	const bodyCloseMatch = newHtmlNoComments.match(bodyCloseExp);
	inject.navbar.modern.index = bodyCloseMatch?.index ?? newHtml.length;

	// Try to find start and end indexes of frameset, so it can be removed if needed
	const framesetExp = /<frameset.*?>.*<\/frameset> *\n?/is;
	const framesetMatch = newHtmlNoComments.match(framesetExp);
	if (framesetMatch !== null)
		inject.frames.push({
			start: framesetMatch.index,
			end: framesetMatch.index + framesetMatch[0].length,
			type: 'frameset',
		});

	// Try to find start and end indexes of noframes opening/closing tags, so they can be removed to display their inner contents if needed
	const noframesExp = /<\/?no ?frames?> *\n?/gi;
	for (let noframesMatch; (noframesMatch = noframesExp.exec(newHtmlNoComments)) !== null;)
		inject.frames.push({
			start: noframesMatch.index,
			end: noframesMatch.index + noframesMatch[0].length,
			type: 'noframes',
		});

	return [newHtml, inject];
}

// Get the title and all visible text on a page
function buildSearch(text, type) {
	const search = {
		title: '',
		content: '',
	};

	if (type == 'text/html') {
		const titleMatch = [...text.matchAll(/<title>((?:(?!<\/title>).)*?)<\/title>/gis)];
		if (titleMatch.length > 0)
			search.title = titleMatch[titleMatch.length - 1][1];

		search.content = text.replace(
			/<title>.*?<\/title>/gis,
			'',
		).replace(
			/<script(?: [^>]*)?>.*?<\/script>/gis,
			'',
		).replace(
			/<[^>]+alt *= *"(.*?)".*?>/gis,
			' $1 ',
		).replace(
			/<[^>]+alt *= *([^ >]+).*?>/gis,
			' $1 ',
		).replace(
			/<! *-+.*?-+ *>/gs,
			'',
		);
	}
	else
		// We can't extract a title from pure text files, so just focus on the description
		search.content = text;

	for (const field in search)
		search[field] = search[field]
			.replace(/<.*?>/gs, ' ')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replace(/(?:\s|&nbsp;)+/gi, ' ')
			.trim();

	return search;
}

// Find an archive in a set of archives for a specific URL that is closest to a given source
function nearestArchiveInfo(compareEntries, sourceId, sanitizedPath = null) {
	let backupUrl = null;
	if (sanitizedPath !== null) {
		// If a sanitized path is defined, try using it to fast-track identification of nearest archive
		// If a match is found but is invalid, take note of its URL and carry on
		const keepAnchor = /(?<=^[^#]+)#[^#]+$/.test(sanitizedPath);
		const exactMatch = compareEntries.find(compareEntry => sourceId == compareEntry.source && sanitizedPath == utils.sanitizePath(compareEntry.path, keepAnchor));
		if (exactMatch !== undefined) {
			if (!exactMatch.error && !exactMatch.skip)
				return [exactMatch.source, exactMatch.url];
			else
				backupUrl = exactMatch.url;
		}
	}

	// Filter archive set to only include valid archives
	// If we end up with only a single archive, then we don't need to continue
	const compareEntriesNoSkip = compareEntries.filter(compareEntry => !compareEntry.skip);
	if (compareEntriesNoSkip.length == 1)
		return [compareEntriesNoSkip[0].source, compareEntriesNoSkip[0].url];

	// Same as above, but filtered further to not include error pages
	const compareEntriesNoError = compareEntriesNoSkip.filter(compareEntry => !compareEntry.error);
	if (compareEntriesNoError.length == 1)
		return [compareEntriesNoError[0].source, compareEntriesNoError[0].url];

	// Now create a "definitive" filtered archive set that doesn't include error pages unless there are only error pages
	const compareEntriesPure = compareEntriesNoError.length == 0 ? compareEntriesNoSkip : compareEntriesNoError;

	// Loop through each archive and find the one whose source's archive date is the closest to the supplied source
	let lowestTimeDistIndex = -1;
	if (compareEntriesPure.length > 0) {
		const sourceTime = getSourceTime(sourceId);
		let lowestTimeDistValue = -1;
		for (let i = 0; i < compareEntriesPure.length; i++) {
			const timeDist = Math.abs(sourceTime - getSourceTime(compareEntriesPure[i].source));
			if (lowestTimeDistValue == -1 || timeDist < lowestTimeDistValue) {
				lowestTimeDistIndex = i;
				lowestTimeDistValue = timeDist;
			}
		}
	}

	if (lowestTimeDistIndex > -1) {
		// An archive was found, so return its source and URL
		const nearestMatch = compareEntries[lowestTimeDistIndex];
		return [nearestMatch.source, nearestMatch.url];
	}
	else
		// An archive was not found, so return null values
		// Or if an invalid archive match was found, return its URL so we at least have something to point to the Wayback Machine
		return [null, backupUrl];
}

// Convert a given source's date into milliseconds for comparison purposes
// If the date contains only a year, the time is set to the last millisecond of that year
function getSourceTime(sourceId) {
	let sourceDate = sources[sourceId].archiveDate;
	if (sourceDate.length == 4)
		sourceDate = (parseInt(sourceDate, 10) + 1).toString();

	let sourceTime = new Date(sourceDate).getTime();
	if (sourceDate.length == 4)
		sourceTime--;

	return sourceTime;
}

// Attempt to revert source-specific markup alterations
function genericizeMarkup(html, sourceId, path, baseUrl = undefined) {
	switch (sourceId) {
		case 'sgi': {
			// Fix anomaly with HTML files in the Edu/ directory
			if (path.startsWith('Edu/'))
				html = html.replace(/(?<!")\.\.\//g, '/');
			break;
		}
		case 'riscdisc': {
			if (path.startsWith('WWW_BBCNC_ORG_UK'))
				html = html.replace(
					// In bbcnc.org.uk only, the brackets are inside the link elements
					/(?<=<a\s.*?>\s*)\[(.*?)\](?=\s*<\/a>)/gis,
					'$1',
				);
			else
				html = html.replace(
					// Uncomment opening link tags
					/<(?:(?:-- ?)|!(?:-- ?)?)(a\s.*?)(?: ?--)?>/gis,
					'<$1>',
				).replace(
					// Uncomment closing link tags
					/<!?-- ?\/(a)(?: ?--)?>/gi,
					'</$1>',
				).replace(
					// Remove brackets surrounding link elements
					/\[+(<a\s.*?>.*?<\/a>)\]+/gis,
					'$1',
				);
			if (path.startsWith('WWW_HOTWIRED_COM'))
				html = html.replace(
					// Replace imagemap placeholder with unarchived link notice
					/"[./]+no_imagemap\.htm"/gi,
					'"/deadend"',
				);
			break;
		}
		case 'einblicke': {
			html = html.replace(
				// Remove footer
				/\n?<hr>\n?Original: .*? \[\[<a href=".*?">Net<\/a>\]\]\n?$/im,
				'',
			).replace(
				// Replace image link placeholders
				/(?!<img .*?src=)"[./]*(?:teufel|grey)\.gif"(?: alt="\[defekt\]")?/gis,
				'"/deadend"',
			).replace(
				// Replace non-link image placeholders and remove added link
				/<a href=".*?">(<img .*?src=)"[./]*link\.gif" alt="\[image\]"((?:.|\n)*?>)<\/a>/gi,
				'$1"/deadend"$2',
			).replace(
				// Remove broken page warning
				/^<html><body>\n?<img src=".*?noise\.gif">\n?<strong>Vorsicht: Diese Seite k&ouml;nnte defekt sein!<\/strong>\n?\n?<hr>\n?/gi,
				'',
			).replace(
				// Update placeholder for missing forms
				/<p>\n?<strong>Hier sollte eigentlich ein Dialog stattfinden!<\/strong>\n?\[\[<a href=".*?">Net<\/a>\]\]\n?<p>\n?/gi,
				'<p>[[ Unarchived form element ]]</p>',
			).replace(
				// Move external links to original link element
				/(?<=<a (?:(?!<\/a>).)*?href=")[./]*fehler.htm("(?:(?!<\/a>).)*?<\/a>) \[\[<a href="(.*?)">Net<\/a>\]\]/gis,
				'$2$1',
			).replace(
				// Handle extreme edge cases where an error link doesn't have an accompanying external link
				/(?<=<a .*?href=")[./]*fehler.htm(?=".*?>.*?<\/a>)/gis,
				'/deadend',
			);
			break;
		}
		case 'chipfun': {
			// Remove base directory definition
			html = html.replace(/^<base href=".*?">\n/, '');
			break;
		}
		case 'pcpress': {
			// Remove downloader software header
			html = html.replace(/^<META name="download" content=".*?">\n/s, '');
			// Attempt to fix broken external links
			const links = getLinks(html, baseUrl)
				.filter(link => link.hasHttp && URL.canParse(link.rawUrl))
				.toSorted((a, b) => a.index - b.index);
			for (const link of links) {
				const httpExp = /^http:(?=\/?[^/])/i;
				const badDomainExp = /(?<=http:\/\/)[^./]+(?=\/)/i;
				const badAnchorExp = /(?<=#[^/]+)\//i;
				const badExtensionExp = /(?<=\.(html?|cgi|gif))\//i;
				link.url = link.rawUrl;
				if (httpExp.test(link.url))
					link.url = URL.parse(link.url.replace(httpExp, ''), link.baseUrl)?.href ?? link.url;
				if (link.baseUrl !== undefined && badDomainExp.test(link.url))
					link.url = URL.parse(
						link.url.replace(/^http:\/\/.*?\//i, '/'),
						link.baseUrl.replace(/(?<=http:\/\/).*?(?=\.)/i, link.url.match(badDomainExp)[0])
					)?.href ?? link.url;
				link.url = (URL.parse(link.url)?.href
					.replace(/(?<![a-z]+:)\/\//i, '/')
					.replace(/(?<=\.html?)\/$/i, '')
				) ?? link.url;
				const hasBadAnchor = badAnchorExp.test(link.url);
				const hasBadExtension = badExtensionExp.test(link.url);
				if (hasBadAnchor || hasBadExtension) {
					const splitIndex = link.url.search(hasBadAnchor ? badAnchorExp : badExtensionExp);
					const before = link.url.substring(0, splitIndex);
					const after = link.url.substring(splitIndex + 1);
					link.url = URL.parse(after, before)?.href ?? link.url;
				}
			}
			// Inject fixed links into markup
			let offset = 0;
			for (const link of links.filter(filterLink => filterLink.url != filterLink.rawUrl)) {
				const start = link.index;
				const inject = `${link.attribute}"${link.url}"`;
				const end = link.index + link.fullMatch.length;
				html = html.substring(0, start + offset) + inject + html.substring(end + offset);
				offset += inject.length - link.fullMatch.length;
			}
			break;
		}
		case 'roteiro': {
			html = html
				// Remove header
				.replace(/^<a name = \d+>\n/i, '')
				// Remove HTTP header that was inserted into some documents where it shouldn't
				.replace(/^HTTP(?:\/\*)? \d{3} .*\n(?:[^ :]+: .*\n)+\n/, '')
				// Remove footer
				.replace(/(?:<hr>)?\n<h6>Internet URL-\n <a href=.*?>.*?<\/a> <\/h6>\n*$/, '')
				// Fix file URLs
				.replaceAll('file:/http/', '../../')
				// Replace error links
				.replace(/"?\.\.\/\.\.\/dium.htm"?/g, '"/deadend"')
				// Fix broken port injects (what even is this?)
				.replace(/<(:[78]0)/g, '$1/<');
			break;
		}
		case 'netcontrol96':
		case 'netcontrol98': {
			// Remove injected script that exists on exactly one page
			if (path == 'archive-b/ba1/index.shtml')
				html = html
					.replace(/\n?<script [^>]*src="\/archived.js".*?>/, '')
					.replace(/ onLoad="shownew\('\/'\)"/, '');
			// Reverse encryption of email strings
			const decodeEmail = encodedEmail => {
				const bytes = encodedEmail.match(/.{1,2}/g).map(byte => parseInt(byte, 16));
				return bytes.slice(1).map(byte => String.fromCharCode(byte ^ bytes[0])).join('');
			};
			html = html.replace(
				// Remove injected CloudFlare scripts
				/<script [^>]*src="[^"]+\/cloudflare-static\/.*?" data-cf-settings="[0-9a-f]{24}-\|49"(?: defer(?:="")?)?><\/script>/g,
				'',
			).replace(
				// Remove indicators of modified script elements
				/ type="[0-9a-f]{24}-text\/javascript"/g,
				'',
			).replace(
				// Revert altered mouse event attributes
				/if \(!window.__cfRLUnblockHandlers\) return false; /g,
				'',
			).replace(
				// Remove indicators of modified mouse event attributes
				/ data-cf-modified-[0-9a-f]{24}-=""/g,
				'',
			).replace(
				// Restore encrypted plaintext emails
				/<(?:span|template) class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email&#160;protected\]<\/(?:span|template)>/g,
				(_, encodedEmail) => decodeEmail(encodedEmail),
			).replace(
				// Restore encrypted mailto links (variation 1)
				/"\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/g,
				(_, encodedEmail) => 'mailto:' + decodeEmail(encodedEmail),
			).replace(
				// Restore encrypted mailto links (variation 2)
				/<a href="\/cdn-cgi\/l\/email-protection" class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email&#160;protected\]<\/a>/g,
				(_, encodedEmail) => {
					const decodedEmail = decodeEmail(encodedEmail);
					return `<a href="mailto:${decodedEmail}">${decodedEmail}</a>`;
				},
			).replace(
				// Remove injected ads
				/<script[^>]+> <!--var dd=document;.*?--><\/script>/gs,
				'',
			).replace(
				// Remove ad-related comments
				/<!-- (?:GOCLICK\.COM |END OF )POP-UNDER CODE(?: V1)? -->/g,
				'',
			).replace(
				// Remove header comment
				/^<!-- Netcontrol preface \/\/-->/gm,
				'',
			).replace(
				// Revert altered title tags
				/<title>NetControl.net Archive of :: ?(.*?)<\/(title)>/gis,
				'<$2>$1</$2>',
			).replace(
				// Remove title tags that were replaced with file paths
				/<title>\\Stuff\\.*?<\/title>\n?/gi,
				'',
			).replace(
				// Remove metadata tag
				/(?:\n *)?<META NAME="GENERATOR" CONTENT="Mozilla\/.*?">/gim,
				'',
			).replace(
				// Remove indents before header elements
				/(<head>)(.*?)(<\/head>)/gis,
				(_, headOpen, headBody, headClose) => headOpen + headBody.replace(/^ +/gm, '') + headClose,
			).replace(
				// Remove header message
				/(?:<body[^>]+>)?<p align="center">Archived Pages from 20th Century!!<center>\n?<br>(?:<!--#include virtual="[^"]+" -->)?\n?<BR>/gs,
				'',
			).replace(
				// Remove footer HTML (variation 1)
				/\n?<center><br><br><p align="center"><!-- Netcontrol footer \/\/-->/g,
				'',
			).replace(
				// Remove footer HTML (variation 2)
				/<br><center><br>(?:<!--#include virtual=".*?" -->)?<BR><img src="[^"]+\/okto-banner.gif" border=0><\/a>/g,
				'',
			);
			// Fix images on pages with base URL
			if (baseExp.test(html))
				html = html.replace(linkExp, (_, tagStart, url) => {
					if (/^(?:src|background)/i.test(tagStart))
						url = `"${trimQuotes(url.substring(url.lastIndexOf('/') + 1))}"`;
					return tagStart + url;
				});
			break;
		}
		case 'amigaplus': {
			// Convert CD-ROM local links into path links
			html = html.replaceAll('file:///d:/Amiga_HTML/', '/');
			break;
		}
		case 'netonacd': {
			// Move real URLs back to original attribute
			html = html.replace(/"([^"]+)"?\s+tppabs="(.*?)"/g, '"$2"');
			break;
		}
	}
	return html;
}

// Attempt to fix invalid/deprecated/non-standard markup
function improvePresentation(html, compat = false) {
	html = html.replace(
		// Remove cut-off tag at end of document
		/<\/?\s*$/,
		'',
	).replace(
		// Fix closing title tags with missing slash
		/<(title)>((?:(?!<\/title>).)*?)<(title)>/gis,
		'<$1>$2</$3>',
	).replace(
		// Fix attributes with missing end quote
		/([a-z]+ *= *"[^"]*?)(>[^"]*?"[^>]*")/gis,
		'$1"$2',
	).replace(
		// Remove spaces from comment closing sequences
		/(<! *-+(?:(?!<! *-+).)*?-+) +>/gs,
		'$1>',
	).replace(
		// Fix single-line comments with missing closing sequence
		/<!( *-+)([^<\n]+)(?<!-+ *)>(?!(?:(?!<! *-+).)*?-->)/gs,
		'<!$1$2-->',
	).replace(
		// Fix multi-line comments with missing closing sequence
		/<!( *-+)([^<]+)(?<!-+ *)>(?!(?:(?!<! *-+).)*?-+>)/gs,
		'<!$1$2-->',
	).replace(
		// Fix non-standard <marquee> syntax
		/<(marquee) +text *= *"(.*?)".*?>/gis,
		'<$1>$2</$1>',
	).replace(
		// Add missing closing tags to link elements
		/(<(a)\s(?:(?!<\/a>).)*?>(?:(?!<\/a>).)*?)(?=$|<a\s)/gis,
		'$1</$2>',
	).replace(
		// Add missing closing tags to table and font elements
		/(<(table|font)[^>]*>(?:(?!<\/\2>).)*?)(?=(?:<\/body>\s*)?(?:<\/html>\s*)?$)/gis,
		'$1</$2>',
	).replace(
		// Add missing closing tags to list elements
		/(<(dt|dd)>(?:(?!<\/\1>).)*?)(?=<(?:dl|dt|dd|\/dl))/gis,
		'$1</$2>',
	).replace(
		// Add missing "s" to <noframe> elements
		/(<\/?)(no) ?(frame)(>)/gi,
		(_, start, no, frame, end) => start + no + frame + (frame == frame.toUpperCase() ? 'S' : 's') + end,
	);

	// Try to fix any remaining comments with missing closing sequences
	if (/<! *-/.test(html) && !/- *>/.test(html))
		html = html.replace(/<!( *-.*$)/gm, '<!$1-->');

	// Improvements for modern browsers only
	if (!compat) {
		// Convert <plaintext> into <pre>
		// This needs to be done to prevent the navbar from being rendered in plaintext
		const plaintextExp = /<plaintext>/gi;
		for (let match; (match = plaintextExp.exec(html)) !== null;) {
			const openIndex = match.index;
			const startIndex = plaintextExp.lastIndex;
			const endIndex = html.toLowerCase().indexOf('</plaintext>', startIndex);
			const closeIndex = endIndex != -1 ? endIndex + 12 : -1;

			const upperCase = match[0] == match[0].toUpperCase();
			const content = (upperCase ? '<PRE>' : '<pre>')
				+ html.substring(startIndex, endIndex != -1 ? endIndex : undefined).replaceAll('<', '&lt;').replaceAll('>', '&gt;')
				+ (upperCase ? '</PRE>' : '</pre>');

			html = html.substring(0, openIndex) + content + (closeIndex != -1 ? html.substring(closeIndex) : '');
		}

		// Replace <isindex> with plain HTML resembling its appearance in old versions of Netscape/Firefox
		// This is because modern browsers don't render <isindex> at all
		const isindexExp = /<isindex.*?>/gis;
		for (let match; (match = isindexExp.exec(html)) !== null;) {
			const isindex = match[0];
			const matchPrompt = isindex.match(/prompt *= *(".*?"|[^ >]+)/is);
			const matchAction = isindex.match(/action *= *(".*?"|[^ >]+)/is);

			let formStart = '';
			let formEnd = '';
			let prompt = 'This is a searchable index. Enter search keywords: ';
			if (matchPrompt !== null) {
				prompt = trimQuotes(matchPrompt[1]);
				if (!prompt.endsWith(' '))
					prompt += ' ';
			}
			if (matchAction !== null) {
				formStart = `<form action="${trimQuotes(matchAction[1])}">`;
				formEnd = '</form>';
			}

			html = html.substring(0, isindexExp.lastIndex - isindex.length)
				+ formStart + '<hr>' + prompt + '<input><hr>' + formEnd
				+ html.substring(isindexExp.lastIndex);
		}
	}

	return html;
}

// Find and return links in the given markup, without performing any operations
// TODO: Get rid of this eventually
function getLinks(html, baseUrl = undefined) {
	const baseMatch = html.match(baseExp);
	if (baseMatch !== null)
		baseUrl = trimQuotes(baseMatch[1]);

	const links = [];
	for (let linkMatch; (linkMatch = linkExp.exec(html)) !== null;) {
		let attribute = linkMatch[1];
		let rawUrl = trimQuotes(linkMatch[2]);
		let doQuotes = true;
		if (/^http-equiv/i.test(attribute)) {
			const urlPrefix = rawUrl.match(/^\d*;? *(?:URL=)?/i)[0];
			attribute += '"' + urlPrefix;
			rawUrl = rawUrl.substring(urlPrefix.length);
			doQuotes = false;
		}

		// Anchor, missing, and non-HTTP links should be ignored
		const hasHttp = /^https?:/i.test(rawUrl);
		if (rawUrl.startsWith('#') || /^\/deadend$/.test(rawUrl) || (!hasHttp && /^[a-z]+:/i.test(rawUrl)))
			continue;

		links.push({
			fullMatch: linkMatch[0],
			attribute: attribute,
			rawUrl: rawUrl,
			baseUrl: baseUrl || undefined,
			index: linkMatch.index,
			hasHttp: hasHttp,
			doQuotes: doQuotes,
		});
	}

	return links;
}

// Retrieve text from file and convert to UTF-8 if necessary
function getText(filePath, sourceId, url = null) {
	const fileInfo = utils.getPathInfo(filePath);
	if (fileInfo === null || !fileInfo.isFile || fileInfo.size == 0)
		return '';

	let text;
	try {
		const decoder = new TextDecoder();
		switch (sourceId) {
			case 'wwwdir': {
				// World Wide Web Directory has some double-encoding weirdness that needs to be untangled
				text = decoder.decode((
					new Deno.Command('bash', { args: ['-c',
						`HTML="$(iconv '${filePath.replaceAll("'", "\\'")}' -cf UTF-8 -t WINDOWS-1252)"; iconv -cf $(uchardet <(echo -nE "$HTML")) -t UTF-8 <(echo -nE "$HTML")`
					], stdout: 'piped' }).outputSync()
				).stdout);
				break;
			}
			case 'einblicke': {
				// Einblicke ins Internet is already UTF-8 and anything that isn't detected as such causes issues, so don't try to convert it
				text = Deno.readTextFileSync(filePath);
				break;
			}
			case 'pcpress': {
				// Convert from YUSCII if the port is 81, as described by the YU-Font specification
				// Otherwise, convert using the default behavior
				if ((url !== null && /^https?:\/\/[^\/]+:81(?:\/|$)/i.test(url))) {
					text = decoder.decode((
						new Deno.Command('iconv', { args: [filePath, '-cf', 'YU', '-t', 'UTF-8'], stdout: 'piped' }).outputSync()
					).stdout);
					break;
				}
			}
			/* Falls through (this is here to make VSCode happy) */
			default: {
				let uchardetStr = decoder.decode(new Deno.Command('uchardet', { args: [filePath], stdout: 'piped' }).outputSync().stdout).trim();
				// For some reason, files identified as MAC-CENTRALEUROPE/IBM865 only convert correctly if interpreted as WINDOWS-1253
				if (uchardetStr == 'MAC-CENTRALEUROPE' || uchardetStr == 'IBM865')
					uchardetStr = 'WINDOWS-1253';
				// Same with IBM852 and WINDOWS-1252
				if (uchardetStr == 'IBM852')
					uchardetStr = 'WINDOWS-1252';

				// Convert to UTF-8 from the identified character encoding if needed
				// Otherwise, just read it normally
				if (uchardetStr != 'ASCII' && uchardetStr != 'UTF-8')
					text = decoder.decode((
						new Deno.Command('iconv', { args: [filePath, '-cf', uchardetStr, '-t', 'UTF-8'], stdout: 'piped' }).outputSync()
					).stdout);
				else
					text = Deno.readTextFileSync(filePath);

				if (sourceId == 'pcpress') {
					// Convert text surrounded by the extremely non-standard <yu> element as YUSCII
					// TODO: Figure out how content marked as CP852 or CP1250 is supposed to be converted
					const yuExp = /(<yu(?: +[a-z0-9]+)?>)(.*?)(<\/yu>|$)/gis;
					const yuMatches = [...text.matchAll(yuExp)];
					if (yuMatches.length > 0) {
						// We convert again from YUSCII and insert text segments over the stock conversion
						// This kind of sucks, but Deno's command API hurts my brain and this works well enough
						const yuText = decoder.decode((
							new Deno.Command('iconv', { args: [filePath, '-cf', 'YU', '-t', 'UTF-8'], stdout: 'piped' }).outputSync()
						).stdout);
						const yuMatches2 = [...yuText.matchAll(yuExp)];

						let newText = '';
						let offset = 0;
						for (let i = 0; i < yuMatches.length; i++) {
							const yuMatch = yuMatches[i];
							const yuMatch2 = yuMatches2[i];

							const start = yuMatch.index + yuMatch[1].length;
							const end = yuMatch.index + yuMatch[0].length - yuMatch[3].length;
							if (offset > start)
								continue;

							newText += text.substring(0, start - offset) + yuMatch2[2];
							text = text.substring(end - offset);
							offset = end;
						}

						text = newText + text;
					}
				}
			}
		}
	}
	catch { text = Deno.readTextFileSync(filePath); }

	return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

// Identify the file's MIME type by its contents, or by file extension if the returned type is too basic
async function mimeType(filePath) {
	const decoder = new TextDecoder();
	const [magicType, extType] = (await Promise.all([
		new Deno.Command('mimetype', { args: ['-bM', filePath], stdout: 'piped' }).output(),
		new Deno.Command('mimetype', { args: ['-b',  filePath], stdout: 'piped' }).output(),
	])).map(type => decoder.decode(type.stdout).trim());
	if (magicType == 'text/plain') {
		// XBM is a particularly annoying MIME type to identify
		if (extType != 'image/x-xbitmap') {
			const fileInfo = decoder.decode(new Deno.Command('file', { args: ['-b', filePath], stdout: 'piped' }).outputSync().stdout);
			if (fileInfo.startsWith('xbm image'))
				return 'image/x-xbitmap';
		}
		return extType;
	}
	else if (magicType == 'application/octet-stream' && !extType.startsWith('text/'))
		return extType;
	else
		return magicType;
}

// Remove any quotes or whitespace surrounding a string
function trimQuotes(str) { return str.trim().replace(/^"?(.*?)"?$/s, '$1').replace(/[\r\n]+/g, '').trim(); }