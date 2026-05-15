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

// Load overrides for MIME types/character encodings
const overrides = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.inputPath, 'overrides.json')));

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

	// Build URL/path/screenshot indexes
	utils.logMessage('building indexes...');
	const [urlIndex, pathIndex, screenshotIndex] = buildIndexes();

	// Load type index if it exists, or initialize it to be populated during the build process
	const typeIndexPath = pathUtils.join(config.buildPath, 'types.json');
	const typeIndex = !args['clean'] && utils.getPathInfo(typeIndexPath)?.isFile
		? JSON.parse(Deno.readTextFileSync(typeIndexPath))
		: {};

	// Create the build and temporary directories
	Deno.mkdirSync(tempBuildPath, { recursive: true });

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
					types: [],
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
			await buildArchive(archive, urlIndex, pathIndex, typeIndex, targetDir, insertStatement);

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
				types: [],
				warn: false,
				error: orphanEntry.error,
			};

			// Create a containing directory for the current orphan
			const targetDir = utils.getArchiveRootDir(pathUtils.join(orphan.source, sanitizedPath), 'orphans', tempBuildPath);
			Deno.mkdirSync(targetDir, { recursive: true });

			// Create the files
			utils.logMessage(`[${++orphanCurrent}/${orphanTotal}] building ${orphan.source} archive for ${sanitizedPath}...`);
			await buildArchive(orphan, urlIndex, pathIndex, typeIndex, targetDir, insertStatement);

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

	// Save type index to file
	utils.logMessage('saving type index...');
	Deno.writeTextFileSync(pathUtils.join(tempBuildPath, 'types.json'), JSON.stringify(typeIndex, null, '\t'));

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

		// Save screenshot info to file
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
		'types.json',
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
function buildIndexes() {
	const urlIndex = {};
	const pathIndex = {};
	for (const sourceId in sources) {
		if (pathIndex[sourceId] === undefined)
			pathIndex[sourceId] = {};

		const entries = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.inputPath, 'archives', sourceId + '.json')));
		for (const entry of entries) {
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
					error: entry.error,
					skip: entry.skip,
				};
		}
	}

	// Populate screenshot index
	const screenshotIndex = {};
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
		}
	}

	return [urlIndex, pathIndex, screenshotIndex];
}

// Parse an entry's file data, then add to database and file tree
async function buildArchive(archive, urlIndex, pathIndex, typeIndex, targetDir, insertStatement) {
	const [file, type, changed] = await getFile(archive, typeIndex);
	archive.types.push(type);

	// If the loaded file data was changed, copy over the raw file
	if (changed) {
		const filePath = pathUtils.join(config.inputPath, 'archives', archive.source, archive.path);
		Deno.copyFileSync(filePath, pathUtils.join(targetDir, 'raw'));
	}

	const targetPath = pathUtils.join(targetDir, 'file');
	const decoder = new TextDecoder();
	let search;
	if (archive.types[0] == 'text/html') {
		// Decode the HTML and try to revert source-specific modifications, then extract and resolve links and save
		// This process can be repeated up to two more times for different variations of the HTML content
		// (Namely, variations that attempt to fix non-standard/archaic markup with modern/legacy browsers in mind, respectively)
		const html = genericizeMarkup(decoder.decode(file), archive.source, archive.path, archive.url);
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
	else {
		if (archive.types[0].startsWith('text/'))
			// Build description text
			search = buildSearch(decoder.decode(file), archive.types[0]);
		else if (archive.types[0] == 'image/x-xbitmap') {
			// Convert XBM to GIF for when presentation improvements are active
			const file_p = (await inputAndExecute(file, 'convert', ['XBM:-', 'GIF:-'])).stdout;
			Deno.writeFileSync(targetPath + '_p', file_p);
			archive.types.push('image/gif');
		}

		Deno.writeFileSync(targetPath, file);
	}

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

// Retrieve a file's data and parse it
async function getFile(archive, typeIndex = {}) {
	// Make sure the file exists, otherwise return an empty byte array
	const filePath = pathUtils.join(config.inputPath, 'archives', archive.source, archive.path);
	const fileInfo = utils.getPathInfo(filePath);
	if (fileInfo === null || !fileInfo.isFile || fileInfo.size == 0)
		return new Uint8Array();

	// Load the file and shrink it if necessary
	let file = Deno.readFileSync(filePath);
	let changed = false;
	const override = overrides[archive.source + '/' + archive.path];
	if (override !== undefined && (override.start !== null || override.end !== null)) {
		file = file.subarray(override.start || 0, override.end || undefined);
		changed = true;
	}

	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	if (archive.source == 'pcpress') {
		// PC Press Internet CD has a <meta> element inserted at the top of nearly all text files, HTML or otherwise
		const text = decoder.decode(file);
		const metaMatch = text.match(/^<META name="download" content=".*?">\n/s);
		if (metaMatch !== null) {
			const encodedMatch = encoder.encode(metaMatch[0].replace(/\uFFFD/g, ' '));
			file = file.subarray(encodedMatch.length);
			changed = true;
		}
	}
	else if (archive.source == 'roteiro') {
		// A Internet em CD-ROM has header and footer HTML inserted in even non-text files
		const text = decoder.decode(file);
		let start, end;

		// Find indexes of where actual file contents start and end, excluding header/footer HTML
		const headerMatch = text.match(/^(?:<a name = \d+>\r?\n)?HTTP(?:\/(?:\*|[\d.]+))? \d{3} .*\r?\n(?:[^ :]+: .*\r?\n)+\r?\n/i);
		if (headerMatch !== null) {
			const encodedMatch = encoder.encode(headerMatch[0].replace(/\uFFFD/g, ' '));
			start = encodedMatch.length;
		}
		else {
			const headerMatch2 = text.match(/^<a name = \d+>\r?\n/i);
			if (headerMatch2 !== null) {
				const encodedMatch = encoder.encode(headerMatch2[0].replace(/\uFFFD/g, ' '));
				start = encodedMatch.length;
			}
		}
		const footerMatch = text.match(/(?:<hr>)?\r?\n<h6>Internet URL-\r?\n <a href=.*?>.*?<\/a> <\/h6>\r?\n*$/);
		if (footerMatch !== null) {
			const encodedMatch = encoder.encode(footerMatch[0].replace(/\uFFFD/g, ' '));
			end = file.length - encodedMatch.length;
		}

		// Shrink the byte array accordingly
		if (start !== undefined || end !== undefined) {
			file = file.subarray(start || 0, end);
			changed = true;
		}
	}

	// It is now safe to gather the file's MIME type
	const typeField = archive.source + '/' + archive.path;
	let type = typeIndex[typeField];
	if (type === undefined) {
		if (override !== undefined && override.type !== null)
			// A type override exists
			type = override.type;
		else if (archive.error)
			// Error pages are always HTML
			type = 'text/html';
		else
			// Automatically determine the type
			type = await mimeType(file, filePath, archive.url);

		// Insert the newly-determined type into the type index
		typeIndex[typeField] = type;
	}

	// Fix weirdly-formatted GIFs present in The Risc Disc Volume 2
	if (archive.source == 'riscdisc' && type == 'image/gif') {
		file = (await inputAndExecute(file, 'convert', ['GIF:-', '+repage', 'GIF:-'])).stdout;
		changed = true;
	}

	if (type.startsWith('text/')) {
		// World Wide Web Directory files are double-encoded
		if (archive.source == 'wwwdir')
			file = (await inputAndExecute(file, 'iconv', ['-cf', 'UTF-8', '-t', 'WINDOWS-1252'])).stdout;

		// Einblicke ins Internet is already UTF-8 and anything that isn't detected as such causes issues
		if (archive.source != 'einblicke') {
			let charset;
			if (override !== undefined && override.charset !== null)
				// There is a character encoding override, so just use that
				charset = override.charset;
			else {
				// Try to identify the character encoding using uchardet
				charset = decoder.decode((await inputAndExecute(file, 'uchardet')).stdout).trim();

				// For some reason, files identified as MAC-CENTRALEUROPE/IBM865 only convert correctly if interpreted as WINDOWS-1253
				if (charset == 'MAC-CENTRALEUROPE' || charset == 'IBM865')
					charset = 'WINDOWS-1253';
				// Same with IBM852 and WINDOWS-1252
				else if (charset == 'IBM852')
					charset = 'WINDOWS-1252';
				else if (charset == 'unknown') {
					// If the source is The Risc Disc Volume 2, then the file probably uses the RISC OS character set which is based on ISO-8859-1
					// Otherwise, screw it. It's UTF-8
					if (archive.source == 'riscdisc')
						charset = 'ISO-8859-1';
					else
						charset = 'UTF-8';
				}
			}

			// Convert to UTF-8 from the identified character encoding if not already UTF-8
			if (charset != 'ASCII' && charset != 'UTF-8')
				file = (await inputAndExecute(file, 'iconv', ['-cf', charset, '-t', 'UTF-8'])).stdout;
		}

		// Check if the file belongs to PC Press Internet CD and resides on the .yu TLD
		let text = decoder.decode(file);
		if (archive.source == 'pcpress' && archive.url !== null && /https?:\/\/[^\/]+\.yu[\/:]/i.test(archive.url)) {
			// If the text contains <yu> elements, convert again from YUSCII and selectively insert segments into the original conversion
			// TODO: Figure out if content marked as CP852 or CP1250 needs to be converted differently and how
			// TODO: Figure out how to identify <yu>-less YUSCII content without breaking a bunch of other pages in the process
			const yuExp = /(<yu(?: +[a-z0-9]+)?>)(.*?)(<\/yu>|$)/gis;
			const yuMatches = [...text.matchAll(yuExp)];
			if (yuMatches.length > 0) {
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

		// Standardize newlines and re-encode text
		text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
		file = encoder.encode(text);
		changed = true;
	}

	return [file, type, changed];
}

// Identify the file's MIME type
async function mimeType(file, filePath, url = null) {
	const decoder = new TextDecoder();
	const rawText = decoder.decode(file);

	// First, check if the file is multipart and set the type accordingly
	// TODO: Figure out why this doesn't seem to work
	const mixedMatch = rawText.match(/^--(.+)\r?\nContent-type:/i);
	if (mixedMatch !== null) {
		const boundary = mixedMatch[1].includes(' ') ? '"' + mixedMatch[1] + '"' : mixedMatch[1];
		return 'multipart/x-mixed-replace; boundary=' + boundary;
	}

	// Guess the file's type based on its intrinsic properties and file extension
	const [magicType, extType] = (await Promise.all([
		inputAndExecute(file, 'mimetype', ['-b', '--stdin']),
		new Deno.Command('mimetype', { args: ['-b',  filePath], stdout: 'piped' }).output(),
	])).map(type => decoder.decode(type.stdout).trim());

	if (magicType == 'text/plain') {
		// XBM and XPM are always recognized as text/plain and we can't always trust the file extension
		// So we need to manually identify them ourselves
		const xbmMatch = rawText.match(/static(?:\s+unsigned)?\s+char\s+[^\s]*_bits\[\]\s*=\s*\{/i);
		if (xbmMatch !== null)
			return 'image/x-xbitmap';
		const xpmMatch = rawText.match(/^\s*!\s*XPM2/i);
		if (xpmMatch !== null)
			return 'image/x-xpixmap';

		// Likewise, HTML file extensions are not always accurate, so we'll need to check its type manually
		if (extType == 'text/html')
			return isPlaintext(rawText, url) ? magicType : extType;

		// In all other cases, just use the file extension since it will probably be the most specific
		return extType;
	}
	else if (magicType == 'application/octet-stream' && !extType.startsWith('text/'))
		return extType;
	else
		return magicType;
}

// Guess if a piece of text is HTML or plaintext
function isPlaintext(text, url = null) {
	// If it has an HTML comment opening sequence, then it's probably HTML
	if (text.includes('<!--'))
		return false;

	const parsedUrl = URL.parse(url);
	const hasHtmlExt = parsedUrl !== null && /\.html?$/i.test(parsedUrl.pathname);
	const tagMatches = [...text.matchAll(/<\/?([a-z\d]+)(?: [^>\n]*?)?>/gi)];
	if (tagMatches.length > 0 && hasHtmlExt)
		// If there appear to be HTML tags and the URL has an HTML file extension, then it's probably HTML
		return false;
	else if (tagMatches.length == 0)
		// If there is nothing resembling HTML tags, and it has newlines or a non-HTML file extension, then it's probably plaintext
		return !hasHtmlExt || text.trim().includes('\n');

	// Compare each apparent HTML tag to a list of common tags
	// If one matches, then it's probably HTML
	const validTags = [
		'html', 'head', 'title', 'meta', 'body',
		'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
		'p', 'b', 'i', 'u', 'a', 'img', 'pre', 'hr',
		'ul', 'ol', 'li', 'dl', 'dt', 'dd',
		'table', 'tr', 'th', 'td', 'input', 'button',
		'isindex', 'plaintext', 'frame', 'frameset',
		'applet', 'param',
	];
	for (const tagMatch of tagMatches) {
		const tag = tagMatch[1].toLowerCase();
		if (validTags.some(validTag => tag == validTag))
			return false;
	}

	// If none of the apparent HTML tags match, then they're probably not HTML tags and it's probably plaintext
	return true;
}

// Execute a command with input data and return its output
function inputAndExecute(input, app, args = undefined) {
	const process = new Deno.Command(app, { args: args, stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn();
	const writer = process.stdin.getWriter();
	const writePromise = writer.ready
			.then(() => writer.write(input))
			.then(() => writer.close())
			.catch(() => {}); // This is here because mimetype likes to throw errors on random files for some reason (it still works though)
	const readPromise = process.output();
	return Promise.all([writePromise, readPromise]).then(([_, output]) => {
		process.unref();
		return output;
	});
}

// Remove any quotes or whitespace surrounding a string
function trimQuotes(str) { return str.trim().replace(/^"?(.*?)"?$/s, '$1').replace(/[\r\n]+/g, '').trim(); }