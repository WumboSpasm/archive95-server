import { contentType } from 'jsr:@std/media-types@1.1.0';
import { Database } from 'jsr:@db/sqlite@0.13';
import { parseArgs } from 'jsr:@std/cli/parse-args';
import * as pathUtils from 'jsr:@std/path';

import * as utils from './utils.js';

// Parse command-line arguments
const args = parseArgs(Deno.args, {
	string: ['config'],
	default: { 'config': 'config.json' },
});

// Load configuration
utils.loadConfig(args['config']);

const templates = loadTemplates();
const modes = JSON.parse(Deno.readTextFileSync('data/modes.json'));
const flags = JSON.parse(Deno.readTextFileSync('data/flags.json'));
const highlights = JSON.parse(Deno.readTextFileSync('data/highlights.json'));
const sources = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.buildPath, 'sources.json')));
const stats = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.buildPath, 'stats.json')));

const [homeContentCompat, homeHighlightsModern] = buildHomeContent();
const sourcesPage = buildSourcesPage();

// Load the database
utils.logMessage('opening database...');
const searchDatabase = new Database(pathUtils.join(config.buildPath, 'search.sqlite'), { strict: true, readonly: true });
searchDatabase.exec('PRAGMA shrink_memory');

// Mount the filesystem
const buildVhdPath = pathUtils.join(config.buildPath, 'build.qcow2');
const buildMountPath = pathUtils.join(config.buildPath, 'mount');
let usingVhd = false;
if (utils.getPathInfo(buildVhdPath)?.isFile) {
	utils.logMessage('mounting filesystem...');
	if (!utils.getPathInfo(buildMountPath)?.isDirectory)
		Deno.mkdirSync(buildMountPath);
	if (!utils.mountVhd(buildVhdPath, buildMountPath, true)) {
		utils.logMessage('failed to mount filesystem');
		Deno.exit(1);
	}
	usingVhd = true;
}

// Start the server
let httpServer, httpsServer;
(function startServer() {
	// ...over HTTP
	httpServer = Deno.serve({
		port: config.httpPort,
		hostname: config.hostName,
		onListen: serverListen,
		onError: serverError,
	}, serverHandler);

	// ...over HTTPS
	if (config.httpsPort && config.httpsCert && config.httpsKey)
		httpsServer = Deno.serve({
			port: config.httpsPort,
			cert: Deno.readTextFileSync(config.httpsCert),
			key: Deno.readTextFileSync(config.httpsKey),
			hostName: config.hostName,
			onListen: serverListen,
			onError: serverError,
		}, serverHandler);
})();

// Handle incoming requests
function serverHandler(request, info) {
	const ipAddress = info.remoteAddr.hostname;
	const userAgent = request.headers.get('User-Agent') ?? '';

	// Check if IP or user agent is in blocklist
	const blockRequest =
		config.blockedIPs.some(blockedIP => ipAddress.startsWith(blockedIP)) ||
		config.blockedUAs.some(blockedUA => userAgent.includes(blockedUA));

	// Log the request if desired
	if (!blockRequest || config.logBlockedRequests)
		utils.logMessage(`${blockRequest ? 'BLOCKED ' : ''}${ipAddress} (${userAgent}): ${request.url}`);

	// Block the request if it needs to be blocked
	if (blockRequest)
		throw new BlockedError();

	// Parse the request URL
	const requestUrl = URL.parse(request.url);
	if (requestUrl === null)
		throw new BadRequestError();

	// If access host is configured, do not allow connections through any other hostname
	// (ancient browsers that do not send the Host header are exempt from this rule)
	if (config.accessHosts.length > 0 && !config.accessHosts.some(host => host == requestUrl.hostname) && request.headers.has('Host'))
		throw new BadHostError();

	// Render search page and navbar in HTML5 if the browser seems to be modern
	const modernMode = config.doModernMode && isModernBrowser(userAgent);

	// Render pages in UTF-8 if the browser does not seem to be ancient
	const doUnicode = modernMode || !isAncientBrowser(userAgent);

	// Get body of request URL
	const requestPath = utils.safeDecode(requestUrl.pathname.replace(/^\/+/, ''));

	// Initialize response headers
	const headers = new Headers();
	headers.set('Content-Type', 'text/html' + (doUnicode ? ';charset=UTF-8' : ''));
	headers.set('Cache-Control', 'max-age=14400');

	// Serve homepage/search results
	if (requestPath == '')
		return new Response(buildSearch(requestUrl.searchParams, modernMode), { headers: headers });

	// Try serving from static file directory
	const staticFilePath = 'static/' + requestPath;
	if (utils.getPathInfo(staticFilePath)?.isFile) {
		headers.set('Content-Type', contentType(staticFilePath.substring(staticFilePath.lastIndexOf('.'))) ?? 'application/octet-stream');
		return new Response(Deno.openSync(staticFilePath).readable, { headers: headers });
	}

	// Separate route and URL components, and clean up slashes
	let routeStr, urlStr;
	const pathSeparator = requestPath.indexOf('/');
	if (pathSeparator > 0) {
		routeStr = requestPath.substring(0, pathSeparator);
		urlStr = requestPath.substring(pathSeparator + 1).replace(/^\/+/, '').replaceAll('%23', '#');
		if (requestUrl.search == '' && request.url.endsWith('?'))
			urlStr += '?';
		else
			urlStr += requestUrl.search;
	}
	else {
		routeStr = requestPath.replace(/\/+$/, '');
		urlStr = '';
	}

	// Parse the route
	const routeMatch = routeStr.match(/^([a-z0-9]+)(?:-([a-z0-9]+)(\+\d+)?)?(?:_([a-z0-9]+))?$/);
	if (routeMatch === null)
		throw new NotFoundError();

	// Extract route segments and check their validity
	let [_, modeId, sourceId, offset, flagIds] = routeMatch;
	const mode = modes.find(mode => modeId == mode.id);
	if (mode === undefined
	|| (!mode.hasSource && sourceId !== undefined)
	|| (!mode.hasOffset && offset !== undefined)
	|| (!mode.hasFlags && flagIds !== undefined)
	|| (mode.hasUrl == (urlStr == '')))
		throw new NotFoundError();

	// If the supplied source doesn't exist, clear it so we don't have to worry about it later
	if (sourceId !== undefined && sources[sourceId] === undefined)
		sourceId = undefined;

	// Parse offset as an integer
	offset = parseInt(offset, 10);
	if (isNaN(offset))
		offset = undefined;

	// Clean up and sort flag IDs
	flagIds = flagIds !== undefined ? cleanFlags(flagIds) : '';

	switch (mode.id) {
		case 'view': {
			const archiveInfoSpread = getArchiveInfo(urlStr, sourceId, offset);
			if (archiveInfoSpread === null)
				throw new UnarchivedError(urlStr);

			const [archiveInfoSet, archiveInfoIndex, archiveDir, isOrphan] = archiveInfoSpread;
			const archiveInfo = archiveInfoSet[archiveInfoIndex];
			const archivePathInfo = getArchivePathInfo(archiveDir, flagIds);
			const fileType = archiveInfo.types[Math.min(archivePathInfo.typeIndex, archiveInfo.types.length - 1)];
			if (fileType == 'text/html') {
				// For HTML files, we build a list of slices from the injection list to pass to replaceSlices
				const inject = JSON.parse(Deno.readTextFileSync(archivePathInfo.injectPath));
				const framesetInject = inject.frames.find(frameInject => frameInject.type == 'frameset');
				const doNavbar = !flagIds.includes('n') && (framesetInject === undefined || flagIds.includes('f'));
				const slices = [];

				// Build stylesheet slices
				const styles = [];
				if (modernMode) {
					if (doNavbar)
						styles.push('<link rel="stylesheet" href="/styles/navbar.css">');
					if (!flagIds.includes('p'))
						styles.push('<link rel="stylesheet" href="/styles/presentation.css">');
				}
				if (styles.length > 0)
					slices.push({
						start: inject.styles.index,
						end: null,
						value: styles.join('\n'),
					});

				// Build navbar slice
				if (doNavbar)
					slices.push({
						start: inject.navbar.index,
						end: null,
						value: buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode),
					});

				// Build frame-related slices if applicable
				if (inject.frames.length > 0) {
					// If the 'f' flag is supplied, build a slice to remove <frameset> element and its contents
					if (framesetInject !== undefined && flagIds.includes('f'))
						slices.push({
							start: framesetInject.start,
							end: framesetInject.end,
							value: '',
						});
					// If <frameset> element doesn't exist or the 'f' flag is supplied, remove <noframes> tags to reveal their contents
					if (framesetInject === undefined || flagIds.includes('f')) {
						const noframesInjects = inject.frames.filter(frameInject => frameInject.type == 'noframes');
						for (const noframesInject of noframesInjects)
							slices.push({
								start: noframesInject.start,
								end: noframesInject.end,
								value: '',
							});
					}
				}

				// Build slices for each link on the page
				const embedFlagIds = !flagIds.includes('n') ? cleanFlags(flagIds + 'n') : flagIds;
				for (const linkInject of inject.links) {
					let sliceValue = linkInject.url;
					if (flagIds.includes('e'))
						// If the 'e' flag is supplied, don't process the link except to remove unnecessary anchors
						sliceValue = sliceValue.replace(/%23.*?(?=$|#)/, '');
					else if (linkInject.source !== null)
						// If the link is accompanied by a source, point it within the archive
						sliceValue = `/${buildRoute('view', linkInject.source, linkInject.offset, linkInject.embed ? embedFlagIds : flagIds)}/${linkInject.url}`;
					else if (/^https?:/i.test(linkInject.url)) {
						if (linkInject.embed || flagIds.includes('w'))
							// Do the same as above if the 'w' flag is supplied or if the link is for embedded content
							// It's fine if the link goes nowhere - it's better than potentially loading off-site resources
							sliceValue = `/${buildRoute('view', archiveInfo.source, null, linkInject.embed ? embedFlagIds : flagIds)}/${linkInject.url}`;
						else
							// Otherwise, point the link to the Wayback Machine
							sliceValue = buildWaybackLink(linkInject.url, archiveInfo);
					}
					else if (!/^[a-z]+:/i.test(linkInject.url))
						// If the link has no source and is not a full URL, point it within the archive even though it's guaranteed not to be a valid link
						sliceValue = `/${buildRoute('view', archiveInfo.source, null, linkInject.embed ? embedFlagIds : flagIds)}/${linkInject.url.replace(/^\/+/, '')}`;

					slices.push({
						start: linkInject.index,
						end: null,
						value: sliceValue,
					});
				}

				// Apply our built slices to the HTML and serve it
				const html = replaceSlices(Deno.readTextFileSync(archivePathInfo.filePath), slices);
				return new Response(html, { headers: headers });
			}
			else if (!flagIds.includes('n')) {
				// Embed non-HTML files using the most appropriate template if the navbar is enabled
				const fileUrl = `/${buildRoute('view', archiveInfo.source, archiveInfo.offset, cleanFlags(flagIds + 'n'))}/${archiveInfo.url}`;
				let embed, indent = 'all';
				if (utils.isTextType(fileType)) {
					embed = buildHtml(templates.compat.embed.text, {
						'TEXT': Deno.readTextFileSync(archivePathInfo.filePath).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
					});
					indent = 'first';
				}
				else {
					if (fileType.startsWith('image/'))
						embed = templates.compat.embed.image;
					else if (fileType.startsWith('audio/'))
						embed = templates.compat.embed.audio;
					else if (fileType.startsWith('video/'))
						embed = templates.compat.embed.video;
					else
						embed = 'This file cannot be embedded.';

					embed = buildHtml(embed, {
						'FILE': fileUrl,
						'TYPE': fileType,
					});
				}

				// Build download links to the file being embedded
				const downloadsArr = [];
				if (archiveInfo.types.length > 1 && !flagIds.includes('p')) {
					const originalFileUrl = `/${buildRoute('view', archiveInfo.source, archiveInfo.offset, cleanFlags(flagIds + 'np'))}/${archiveInfo.url}`;
					downloadsArr.push(
						`<a href="${originalFileUrl}">Download (original)</a>`,
						`<a href="${fileUrl}">Download (converted)</a>`,
					);
				}
				else
					downloadsArr.push(`<a href="${fileUrl}">Download</a>`);

				// We don't need to do any fancy navbar injection here
				const navbar = buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode);
				const html = buildHtml(templates.compat.embed.main, {
					'URL': (isOrphan ? archiveInfo.source + '/' : '') + sanitizeInject(decodeURI(archiveInfo.url)),
					'STYLE': modernMode ? '<link rel="stylesheet" href="/styles/navbar.css">' : '',
					'COMPATNAVBAR': !modernMode ? navbar : '',
					'EMBED': { value: embed, indent: indent },
					'DOWNLOADS': downloadsArr.join(' - '),
					'MODERNNAVBAR': modernMode ? navbar : '',
				});

				return new Response(html, { headers: headers });
			}
			else {
				// Plainly serve the file if the navbar is disabled and it's not an HTML file
				headers.set('Content-Type', fileType + (doUnicode && fileType.startsWith('text/') ? ';charset=UTF-8' : ''));
				return new Response(Deno.openSync(archivePathInfo.filePath).readable, { headers: headers });
			}
		}
		case 'raw': {
			const archiveInfoSpread = getArchiveInfo(urlStr, sourceId, offset);
			if (archiveInfoSpread === null)
				throw new NotFoundError();

			const [archiveInfoSet, archiveInfoIndex, archiveDir] = archiveInfoSpread;
			const archiveInfo = archiveInfoSet[archiveInfoIndex];

			let archiveRawPath = pathUtils.join(archiveDir, 'raw');
			if (!utils.getPathInfo(archiveRawPath)?.isFile)
				archiveRawPath = pathUtils.join(archiveDir, 'file');

			headers.set('Content-Type', archiveInfo.types[0]);
			return new Response(Deno.openSync(archiveRawPath).readable, { headers: headers });
		}
		case 'browse': {
			// Look for the directory listing file and load it
			const browseFileName = sourceId !== undefined ? `browse_${sourceId}.json` : 'browse.json';
			let browseFilePath = pathUtils.join(utils.getArchiveRootDir(utils.sanitizeUrl(urlStr), 'urls', buildMountPath), browseFileName);
			let isOrphan = false;
			if (!utils.getPathInfo(browseFilePath)?.isFile) {
				if (sourceId === undefined)
					throw new NotFoundError();
				else {
					browseFilePath = pathUtils.join(utils.getArchiveRootDir(pathUtils.join(sourceId, utils.sanitizePath(urlStr)), 'orphans', buildMountPath), browseFileName);
					if (!utils.getPathInfo(browseFilePath)?.isFile)
						throw new NotFoundError();
					isOrphan = true;
				}
			}
			const browse = JSON.parse(Deno.readTextFileSync(browseFilePath));

			// Build path header
			const browseRoute = buildRoute('browse', sourceId, null, flagIds);
			const browseNavigationArr = [];
			const sanitizedBrowsePath = [];
			const encodedBrowsePath = [];
			for (let i = 0; i < browse.path.length; i++) {
				sanitizedBrowsePath.push(sanitizeInject(browse.path[i]));
				encodedBrowsePath.push(encodeURI(browse.path[i]));
				if (i < browse.path.length - 1)
					browseNavigationArr.push(`<a href="/${browseRoute}/${encodedBrowsePath.slice(isOrphan ? 1 : 0).join('/')}">${encodedBrowsePath[i]}</a>`);
				else
					browseNavigationArr.push(sanitizedBrowsePath[i]);
			}

			// If we're viewing an orphan directory, temporarily remove the path segment representing the source to prevent issues
			if (isOrphan)
				encodedBrowsePath.shift();

			// Initialize entry list and the character lengths for each column
			const columnLengths = [0, 0, 0, 0, 0, 0];
			const browseEntries = [];
			const addBrowseEntry = browseEntry => {
				browseEntries.push(browseEntry);
				for (let i = 0; i < browseEntry.length - 1; i++) {
					if (browseEntry[i][1].length > columnLengths[i])
						columnLengths[i] = browseEntry[i][1].length;
				}
			};

			// Add column headers and (if applicable) parent directory button to entry list
			addBrowseEntry([['Name', 'Name'], ['From', 'From'], ['To', 'To'], ['Type', 'Type'], ['Size', 'Size'], ['#', '#'], 'blank.gif']);
			if (browse.path.length > 1)
				addBrowseEntry([
					[`<a href="/${browseRoute}/${encodedBrowsePath.slice(0, -1).join('/')}">Parent Directory</a>`, 'Parent Directory'],
					['-', '-'], ['-', '-'], ['-', '-'], ['-', '-'], ['-', '-'],
					'back.gif',
				]);

			// Add directories to entry list
			for (const browseDir of browse.dirs) {
				const browseDirName = (browseDir.name.length > 40 ? browseDir.name.substring(0, 37) + '...' : browseDir.name) + '/';
				const browseDirCount = browseDir.count.toString();
				addBrowseEntry([
					[`<a href="/${browseRoute}/${encodedBrowsePath.concat(encodeURI(browseDir.name)).join('/')}">${sanitizeInject(browseDirName)}</a>`, browseDirName],
					['-', '-'], ['-', '-'], ['-', '-'], ['-', '-'],
					[browseDirCount, browseDirCount],
					'dir.gif',
				]);
			}

			// Add files to entry list
			for (const browseFile of browse.files) {
				const fromLink = `/${buildRoute('view', browseFile.from.source, browseFile.from.offset, flagIds)}/${browseFile.from.url}`;
				const toLink = `/${buildRoute('view', browseFile.to.source, browseFile.to.offset, flagIds)}/${browseFile.to.url}`;
				const isIndex = browseFile.name == '[__ARCHIVE95_INDEX__]';

				// Determine which icon to use based on the file's MIME type
				let icon = 'generic.gif';
				if (browseFile.type.startsWith('text/'))
					icon = 'text.gif';
				else if (browseFile.type.startsWith('image/'))
					icon = 'image.gif';
				else if (browseFile.type.startsWith('audio/'))
					icon = 'sound.gif';
				else if (browseFile.type.startsWith('video/'))
					icon = 'movie.gif';
				else if (browseFile.type.startsWith('application/'))
					icon = 'binary.gif';

				const browseFileName = isIndex ? 'Index File' : (browseFile.name.length > 40 ? browseFile.name.substring(0, 37) + '...' : browseFile.name);
				const browseFileType = browseFile.type.replace(/;.*$/, '');
				const browseFileSize = browseFile.size.toString();
				const browseFileCount = browseFile.count.toString();
				addBrowseEntry([
					[(isIndex ? '<b>' : '') + `<a href="${fromLink}">${sanitizeInject(browseFileName)}</a>` + (isIndex ? '</b>' : ''), browseFileName],
					[`<a href="${fromLink}">${browseFile.from.date}</a>`, browseFile.from.date],
					[`<a href="${toLink}">${browseFile.to.date}</a>`, browseFile.to.date],
					[browseFileType, browseFileType],
					[browseFileSize, browseFileSize],
					[browseFileCount, browseFileCount],
					icon,
				]);
			}

			// Build appropriately-spaced HTML for each entry in the list
			const browseEntryLines = [];
			for (const browseEntry of browseEntries) {
				let line = `<img src="/images/browse/${browseEntry[6]}"> `;
				for (let i = 0; i < browseEntry.length - 1; i++) {
					line += browseEntry[i][0];
					if (i < browseEntry.length - 2) {
						// Circa dates are rendered one character to the left for extra fanciness
						let numSpaces = columnLengths[i] - browseEntry[i][1].length;
						if (browseEntry[i + 1][1].startsWith('~')) {
							browseEntry[i + 1][0] += ' ';
							numSpaces += 3;
						}
						else
							numSpaces += 4;

						line += ' '.repeat(numSpaces);
					}
				}

				browseEntryLines.push(line);
			}

			// Restore path segment representing the source if we're viewing an orphan directory
			if (isOrphan)
				encodedBrowsePath.unshift(sourceId);

			const browsePage = buildHtml(templates.compat.browse.main, {
				'DIR': sanitizedBrowsePath.join('/'),
				'NAVIGATION': browseNavigationArr.join(' / ') + ' /',
				'COLUMNS': browseEntryLines[0],
				'ENTRIES': browseEntryLines.slice(1).join('\n'),
			});
			return new Response(browsePage, { headers: headers });
		}
		case 'inlinks': {
			let inlinks, displayUrl;

			// Check inlinks_urls and inlinks_orphans directories for list of inlinks
			const sanitizedUrl = utils.sanitizeUrl(urlStr);
			let inlinksDir = utils.getArchiveRootDir(sanitizedUrl, 'inlinks_urls', buildMountPath);
			let inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
			if (utils.getPathInfo(inlinksPath)?.isFile) {
				inlinks = JSON.parse(Deno.readTextFileSync(inlinksPath));
				displayUrl = sanitizedUrl;
			}
			else if (sourceId !== null) {
				const sanitizedPath = utils.sanitizePath(urlStr);
				inlinksDir = utils.getArchiveRootDir(pathUtils.join(sourceId, sanitizedPath), 'inlinks_orphans', buildMountPath);
				inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
				if (utils.getPathInfo(inlinksPath)?.isFile) {
					inlinks = JSON.parse(Deno.readTextFileSync(inlinksPath));
					displayUrl = sanitizedPath;
				}
			}

			let content;
			if (inlinks !== undefined && inlinks.length > 0) {
				const links = [];
				for (const inlink of inlinks)
					links.push(buildHtml(templates.compat.inlinks.link, {
						'LINK': `/${buildRoute('view', inlink.source, inlink.offset, flagIds)}/${inlink.url}`,
						'ORIGINAL': inlink.url,
						'SOURCE': inlink.source,
					}));

				content = buildHtml(templates.compat.inlinks.list, { 'LINKS': links.join('\n') });
			}
			else {
				content = 'There are no links to this URL.';
				displayUrl = sanitizeInject(sanitizedUrl, true);
			}

			const inlinksPage = buildHtml(templates.compat.inlinks.main, {
				'URL': displayUrl,
				'CONTENT': content,
			});
			return new Response(inlinksPage, { headers: headers });
		}
		case 'options': {
			const archiveInfoSpread = getArchiveInfo(urlStr, sourceId, offset);
			if (archiveInfoSpread === null)
				throw new NotFoundError();

			const [archiveInfoSet, archiveInfoIndex] = archiveInfoSpread;
			const archiveInfo = archiveInfoSet[archiveInfoIndex];

			// Since query strings are off-limits, links masquerading as checkboxes are used to alter flags
			// The "Apply changes" link simply returns you to the viewer with the flags from the current URL
			const optionsList = [];
			for (const flag of flags) {
				if (flag.hidden)
					continue;

				const checked = flagIds.includes(flag.id);
				const newFlagIds = checked ? flagIds.replace(flag.id, '') : cleanFlags(flagIds + flag.id);
				optionsList.push(buildHtml(templates.compat.options.option, {
					'OPTIONURL': `/${buildRoute('options', archiveInfo.source, archiveInfo.offset, newFlagIds)}/${archiveInfo.url}`,
					'FILL': checked != flag.invert ? 'X' : ' ',
					'DESCRIPTION': flag.description,
				}));
			}

			const options = buildHtml(templates.compat.options.main, {
				'OPTIONS': optionsList.join('\n'),
				'ARCHIVEURL': `/${buildRoute('view', archiveInfo.source, archiveInfo.offset, flagIds)}/${archiveInfo.url}`,
			});
			return new Response(options, { headers: headers });
		}
		case 'screenshot':
		case 'thumbnail': {
			// Check if the screenshot exists
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(urlStr), 'screenshots', buildMountPath);
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (!utils.getPathInfo(screenshotInfoSetPath)?.isFile)
				throw new NotFoundError();

			// Identify the desired screenshot from the set (mostly lifted from getArchiveInfo)
			const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
			let screenshotInfoIndex = -1;
			if (screenshotInfoSet.length > 1 && sourceId !== undefined) {
				for (let i = 0; i < screenshotInfoSet.length; i++) {
					if (sourceId == screenshotInfoSet[i].source) {
						if (urlStr == screenshotInfoSet[i].url) {
							screenshotInfoIndex = i;
							if (offset === undefined || offset == screenshotInfoSet[i].offset)
								break;
						}
					}
				}
			}
			if (screenshotInfoIndex == -1)
				screenshotInfoIndex = 0;

			// Determine the screenshot's path and serve it
			const screenshotInfo = screenshotInfoSet[screenshotInfoIndex];
			const screenshotDir = pathUtils.join(screenshotRootDir, screenshotInfoIndex.toString().padStart(2, '0') + '_' + screenshotInfo.source);
			const screenshotPath = pathUtils.join(screenshotDir, mode.id);
			headers.set('Content-Type', screenshotInfo.type);
			return new Response(Deno.openSync(screenshotPath).readable, { headers: headers });
		}
		case 'random': {
			// Modify the query based on the provided flags and source
			const whereConditions = [];
			const whereParameters = [];
			if (!flagIds.includes('m'))
				whereConditions.push("type = 'text/html'");
			if (flagIds.includes('o'))
				whereConditions.push('orphan = 0');
			if (sourceId !== undefined) {
				whereConditions.push(`source = ?`);
				whereParameters.push(sourceId);
			}

			// Query for a random archive
			const archiveInfo = searchDatabase.prepare(`
				SELECT source, url FROM search
				${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}
				ORDER BY random() LIMIT 1
			`).get(...whereParameters);

			const randomUrl = `/${buildRoute('view', archiveInfo.source, archiveInfo.offset, flagIds)}/${archiveInfo.url.replaceAll('#', '%23')}`;
			if (modernMode)
				// Perform an HTTP redirect if modern mode is active
				return Response.redirect(requestUrl.origin + randomUrl);
			else {
				// Otherwise, return a page that instantly redirects using <meta http-equiv="refresh">
				headers.set('Cache-Control', 'no-store');
				return new Response(buildHtml(templates.compat.random.main, { 'URL': randomUrl }), { headers: headers });
			}
		}
		case 'api': {
			headers.set('Content-Type', 'application/json;charset=UTF-8');

			const subRoute = urlStr.replace(/\/*(?:\?.*)?$/, '');
			const params = requestUrl.searchParams;

			switch (subRoute) {
				case 'search': {
					// Perform a search and return the results
					const [searchResults, _, page] = performSearch(params);
					const json = {
						total: 0,
						page: page,
						prevPage: page > 1 && searchResults.length > 0,
						nextPage: page < config.maxPage && searchResults.length == config.resultsPerPage + 1,
						results: [],
					};

					if (json.nextPage)
						searchResults.pop();
					json.total = searchResults.length;
					json.results = searchResults;

					return new Response(JSON.stringify(json), { headers: headers });
				}
				case 'archives': {
					// Return information on all archives belonging to the given URL
					const urlParam = params.get('url');
					if (urlParam) {
						const sourceParam = sources[params.get('source')] !== undefined ? params.get('source') : undefined;
						const archiveInfoSpread = getArchiveInfo(urlParam, sourceParam);
						if (archiveInfoSpread !== null)
							return new Response(JSON.stringify(archiveInfoSpread[0]), { headers: headers });
					}

					return new Response('[]', { headers: headers });
				}
				case 'get': {
					// Return detailed information on the given archive
					const urlParam = params.get('url');
					if (urlParam) {
						const sourceParam = sources[params.get('source')] !== undefined ? params.get('source') : undefined;
						const offsetParam = parseInt(params.get('offset'), 10) || undefined;
						const archiveInfoSpread = getArchiveInfo(urlParam, sourceParam, offsetParam);
						if (archiveInfoSpread !== null) {
							const [archiveInfoSet, archiveInfoIndex, archiveDir] = archiveInfoSpread;
							const archiveInfo = archiveInfoSet[archiveInfoIndex];

							const archivePathInfo = getArchivePathInfo(archiveDir, params.get('p') == 'true' ? 'p' : '');
							archiveInfo.inject = utils.getPathInfo(archivePathInfo.injectPath)?.isFile
								? JSON.parse(Deno.readTextFileSync(archivePathInfo.injectPath))
								: {};
							archiveInfo.search = utils.getPathInfo(archivePathInfo.searchPath)?.isFile
								? JSON.parse(Deno.readTextFileSync(archivePathInfo.searchPath))
								: {};

							return new Response(JSON.stringify(archiveInfo), { headers: headers });
						}
					}

					return new Response('{}', { headers: headers });
				}
				case 'browse': {
					// Return the contents of the given directory
					const urlParam = params.get('url');
					const sourceParam = params.get('source') || undefined;
					if (urlParam && (sourceParam === undefined || sources[sourceParam] !== undefined)) {
						const browseFileName = sourceParam !== undefined ? `browse_${sourceParam}.json` : 'browse.json';
						let browseFileDir = utils.getArchiveRootDir(utils.sanitizeUrl(urlParam), 'urls', buildMountPath);
						let browseFilePath = pathUtils.join(browseFileDir, browseFileName);
						if (!utils.getPathInfo(browseFilePath)?.isFile && sourceParam !== undefined) {
							browseFileDir = utils.getArchiveRootDir(pathUtils.join(sourceParam, utils.sanitizePath(urlParam)), 'orphans', buildMountPath);
							browseFilePath = pathUtils.join(browseFileDir, browseFileName);
						}
						if (utils.getPathInfo(browseFilePath)?.isFile)
							return new Response(Deno.readTextFileSync(browseFilePath), { headers: headers });
					}

					return new Response('{}', { headers: headers });
				}
				case 'inlinks': {
					// Return all archived pages which link to the given URL
					const urlParam = params.get('url');
					if (urlParam) {
						let inlinksDir = utils.getArchiveRootDir(utils.sanitizeUrl(urlParam), 'inlinks_urls', buildMountPath);
						let inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
						if (!utils.getPathInfo(inlinksPath)?.isFile && sources[params.get('source')] !== undefined) {
							inlinksDir = utils.getArchiveRootDir(pathUtils.join(params.get('source'), utils.sanitizePath(urlParam)), 'inlinks_orphans', buildMountPath);
							inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
						}
						if (utils.getPathInfo(inlinksPath)?.isFile)
							return new Response(Deno.readTextFileSync(inlinksPath), { headers: headers });
					}

					return new Response('[]', { headers: headers });
				}
			}

			throw new NotFoundError();
		}
		case 'about': {
			return new Response(templates.compat.about.main, { headers: headers });
		}
		case 'sources': {
			return new Response(sourcesPage, { headers: headers });
		}
		case 'deadend': {
			const deadendPage = buildHtml(templates.compat.error.main, {
				'STATUSTEXT': 'Dead End',
				'MESSAGE': 'If you reached this page, it means the original destination of the link you followed has been lost.',
				'LINKS': buildHtml(templates.compat.error.links, { 'OPTIONS': '' }),
			});
			return new Response(deadendPage, { status: 404, headers: headers });
		}
	}
}

// Log when the server begins listening on a port
function serverListen(addr) {
	utils.logMessage(`listening on http${addr.port == config.httpsPort ? 's' : ''}://${addr.hostname}:${addr.port}/`);
}

// Build the error page
function serverError(error) {
	const status = error.status || 500;
	const statusText = error.statusText || 'Internal Server Error';
	const message = error.name == 'ArchiveError' ? error.message : 'The server had trouble processing your request.';

	const errorPage = buildHtml(templates.compat.error.main, {
		'STATUSTEXT': statusText,
		'MESSAGE': message,
		'LINKS': error.options instanceof Array
			? buildHtml(templates.compat.error.links, { 'OPTIONS': error.options.join('\n') })
			: '',
	});

	// The server did not purposefully invoke this error, so dump the stack
	if (error.name != 'ArchiveError')
		utils.logMessage(error.stack);

	return new Response(errorPage, { status: status, headers: { 'Content-Type': 'text/html' } });
}

// Shut down the server gracefully when a SIGINT signal is received
async function serverShutdown() {
	if (httpServer) {
		utils.logMessage('shutting down server on HTTP...');
		await httpServer.shutdown();
	}
	if (httpsServer) {
		utils.logMessage('shutting down server on HTTPS...');
		await httpsServer.shutdown();
	}

	if (usingVhd) {
		utils.logMessage('unmounting filesystem...');
		utils.unmountVhd(buildMountPath);
	}

	utils.logMessage('closing database...');
	searchDatabase.close();

	Deno.exit();
}
Deno.addSignalListener('SIGINT', serverShutdown);

// Search the database based on a set of query string parameters and return the results
function performSearch(params) {
	// Build search filters
	const searchFilters = {
		inTitle: !params.has('in') || params.has('in', 'title'),
		inContent: !params.has('in') || params.has('in', 'content'),
		inUrl: !params.has('in') || params.has('in', 'url'),
		formatsAll: !params.has('formats') || params.get('formats') == 'all',
		formatsText: params.get('formats') == 'text',
		formatsMedia: params.get('formats') == 'media',
		source: sources[params.get('source')] !== undefined ? params.get('source') : null,
	};

	// If no search query was supplied, just return the built search filters
	if (!params.has('query'))
		return [[], searchFilters];

	// Parse the requested page and clamp it
	const page = Math.min(config.maxPage, Math.max(1, parseInt(params.get('page'), 10) || 1));

	// "Search in" filter
	const inConditions = [];
	if (searchFilters.inTitle && searchFilters.inContent && searchFilters.inUrl)
		inConditions.push('search MATCH ?1');
	else {
		if (searchFilters.inTitle)
			inConditions.push('title MATCH ?1');
		if (searchFilters.inContent)
			inConditions.push('content MATCH ?1');
		if (searchFilters.inUrl)
			inConditions.push('url MATCH ?1');
	}

	// "Search formats" filter
	let formatCondition;
	if (searchFilters.formatsText)
		formatCondition = "type LIKE 'text/%'";
	else if (searchFilters.formatsMedia)
		formatCondition = "type NOT LIKE 'text/%'";

	// "Search source" filter
	let sourceCondition;
	if (searchFilters.source !== null)
		sourceCondition = `source = '${searchFilters.source}'`;

	// Build WHERE conditional based on supplied filters
	let whereString = inConditions.join(' OR ');
	if (formatCondition !== undefined || sourceCondition !== undefined)
		whereString = '(' + whereString + ')';
	if (formatCondition !== undefined)
		whereString += ' AND ' + formatCondition;
	if (sourceCondition !== undefined)
		whereString += ' AND ' + sourceCondition;

	// Parse the search query
	const query = params.get('query');
	const parsedQuery = query.replace(/"[^"]+"|[^ "]+|"/g, (match, offset, str) => {
		// FTS5 is used for database searches, and it's very easy to make invalid queries
		// An easy fix would be to surround every word in quotation marks, but that would prevent most advanced features from being used
		// So instead we will selectively and meticulously escape the most problematic characters
		if (match == '"')
			// Escape loose quotation marks that aren't surrounding a segment
			return '""';
		else if (match.startsWith('"') && match.endsWith('"'))
			// If the segment is already surrounded by quotation marks, we don't need to do anything
			return match;
		else if (/^https?:\/\/[^ ]+$/i.test(match))
			// If the segment appears to be a URL, sanitize it and surround in quotation marks to maximize potential results
			// This fails to match some URLs and is made mostly redundant by the below code, but meh. When it works it works
			return '"' + utils.sanitizeUrl(match) + '"';
		else
			// Loose words need most non-alphanumeric characters to be escaped
			return match.replace(/[^\w"+:*^]+/g, (subMatch, subOffset) => {
				const realOffset = offset + subOffset;
				const leftPlus = realOffset > 0 && /[\w"]/.test(str[realOffset - 1]) ? '+' : '';
				const rightPlus = realOffset + subMatch.length < str.length && /[\w"]/.test(str[realOffset + subMatch.length]) ? '+' : '';
				return leftPlus + '"' + subMatch.split('').join('"+"') + '"' + rightPlus;
			});
	});

	// Check if the search query matches any URLs when sanitized, and add them to the top of the search results
	const searchResults = [];
	let searchOffset = 0;
	if (searchFilters.inUrl && !/[ "]/.test(query)) {
		const archiveInfoSpread = getArchiveInfo(query, searchFilters.source || undefined);
		if (archiveInfoSpread !== null) {
			const [archiveInfoSet, _, archiveDir, isOrphan] = archiveInfoSpread;
			for (let i = 0; i < archiveInfoSet.length; i++) {
				const archiveInfo = archiveInfoSet[i];

				// Apply search filters
				if (archiveInfo.error
				|| (searchFilters.source !== null && archiveInfo.source != searchFilters.source)
				|| (archiveInfo.types[0].startsWith('text/') && searchFilters.formatsMedia)
				|| (!archiveInfo.types[0].startsWith('text/') && searchFilters.formatsText))
					continue;

				// Update offset but only add to result array if we're on the first page
				searchOffset++;
				if (page > 1)
					continue;

				// Initialize result entry
				const searchResult = {
					source: archiveInfo.source,
					url: archiveInfo.url,
					orphan: isOrphan ? 1 : 0,
					offset: archiveInfo.offset,
					displayUrl: '<b>' + archiveInfo.url + '</b>',
					title: null,
					content: null,
				};

				// Load in title/content text if applicable, trimming the latter to the first 24 words
				const archivePathInfo = getArchivePathInfo(archiveDir);
				if (utils.getPathInfo(archivePathInfo.searchPath)?.isFile) {
					const archiveSearchInfo = JSON.parse(Deno.readTextFileSync(archivePathInfo.searchPath));
					searchResult.title = archiveSearchInfo.title;
					searchResult.content = archiveSearchInfo.content?.match(/^(?:[^\s]+(?:\s+|$)){0,24}/)[0].trimEnd() || null;
					if (searchResult.content !== null && searchResult.content.length < archiveSearchInfo.content.length)
						searchResult.content += '...';
				}

				// Push to result array and prevent the database query from returning duplicates
				searchResults.push(searchResult);
				whereString += ` AND NOT (source == '${archiveInfo.source}' AND url == '${archiveInfo.url}')`;
			}
		}
	}

	try {
		// Attempt to perform the search
		// If there's an error, we just pretend there were no results
		const limit = config.resultsPerPage + 1 - (page == 1 ? searchOffset : 0);
		const offset = (page - 1) * config.resultsPerPage - (page > 1 ? searchOffset : 0);
		searchResults.push(...searchDatabase.prepare(`
			SELECT source, url, orphan, offset,
				highlight(search, 1, '<b>', '</b>') displayUrl,
				highlight(search, 2, '<b>', '</b>') title,
				snippet(search, 3, '<b>', '</b>', '...', 24) content
			FROM search WHERE ${whereString}
			ORDER BY rank LIMIT ?2 OFFSET ?3
		`).all(parsedQuery, limit, offset));
	}
	catch {}

	return [searchResults, searchFilters, page];
}

// Locate the archive in the filesystem and gather useful data
function getArchiveInfo(url, sourceId = undefined, offset = undefined) {
	let archiveInfoSet, archiveInfoIndex, archiveDir, isOrphan = false;

	// Check the urls directory first
	let archiveRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(url), 'urls', buildMountPath);
	let archiveInfoSetPath = pathUtils.join(archiveRootDir, 'archives.json');
	if (utils.getPathInfo(archiveInfoSetPath)?.isFile) {
		// The archive exists in the urls directory, now identify where it resides in the set
		archiveInfoSet = JSON.parse(Deno.readTextFileSync(archiveInfoSetPath));
		archiveInfoIndex = -1;
		if (archiveInfoSet.length > 1 && sourceId !== undefined) {
			for (let i = 0; i < archiveInfoSet.length; i++) {
				// First make sure if the source matches
				if (sourceId == archiveInfoSet[i].source) {
					// If an exact URL (and if defined, offset) match was found, use this archive and stop searching
					if (url == archiveInfoSet[i].url) {
						archiveInfoIndex = i;
						if (offset === undefined || offset == archiveInfoSet[i].offset)
							break;
					}
					// Otherwise, if the archive isn't an error page, use it but keep searching for an exact URL match
					if (!archiveInfoSet[i].error)
						archiveInfoIndex = i;
				}
			}
		}
		// No match was found, so just use the earliest archive
		if (archiveInfoIndex == -1)
			archiveInfoIndex = 0;

		const archiveInfo = archiveInfoSet[archiveInfoIndex];
		archiveDir = pathUtils.join(archiveRootDir, archiveInfoIndex.toString().padStart(2, '0') + '_' + archiveInfo.source);
	}
	else if (sourceId !== undefined) {
		// If a source was provided, check the orphans directory if nothing was found in the urls directory
		archiveRootDir = utils.getArchiveRootDir(pathUtils.join(sourceId, utils.sanitizePath(url)), 'orphans', buildMountPath);
		archiveInfoSetPath = pathUtils.join(archiveRootDir, 'archive.json');
		if (!utils.getPathInfo(archiveInfoSetPath)?.isFile)
			return null;

		const archiveInfo = JSON.parse(Deno.readTextFileSync(archiveInfoSetPath));
		archiveInfoSet = [archiveInfo];
		archiveInfoIndex = 0;
		archiveDir = archiveRootDir;
		isOrphan = true;
	}
	else
		return null;

	return [archiveInfoSet, archiveInfoIndex, archiveDir, isOrphan];
}

// Identify the correct archive file and injection list and return their paths
function getArchivePathInfo(archiveDir, flagIds = '') {
	const archivePathInfo = {
		filePath: pathUtils.join(archiveDir, 'file'),
		injectPath: pathUtils.join(archiveDir, 'inject.json'),
		searchPath: pathUtils.join(archiveDir, 'search.json'),
		typeIndex: 0,
	};

	if (!flagIds.includes('p')) {
		const filePath_p = archivePathInfo.filePath + '_p';
		const injectPath_p = pathUtils.join(archiveDir, 'inject_p.json');
		if (utils.getPathInfo(filePath_p)?.isFile) {
			archivePathInfo.filePath = filePath_p;
			archivePathInfo.injectPath = injectPath_p;
			archivePathInfo.typeIndex = 1;
		}
	}

	return archivePathInfo;
}

// Build home/search pages based on query strings
function buildSearch(params, modernMode) {
	const [searchResults, searchFilters, page] = performSearch(params);
	params.delete('page');

	// Initialize template definitions based on search filters
	const searchDefs = {
		'QUERY': '',
		'INTITLE': searchFilters.inTitle ? ' checked' : '',
		'INCONTENT': searchFilters.inContent ? ' checked' : '',
		'INURL': searchFilters.inUrl ? ' checked' : '',
		'FORMATSALL': searchFilters.formatsAll ? ' checked' : '',
		'FORMATSTEXT': searchFilters.formatsText ? ' checked' : '',
		'FORMATSMEDIA': searchFilters.formatsMedia ? ' checked' : '',
	};

	// Render the homepage if no search query was supplied
	if (!params.has('query')) {
		searchDefs['TITLE'] = 'Archive95';
		searchDefs['HEADER'] = 'Welcome to Archive95';
		if (modernMode) {
			searchDefs['TOTAL'] = (stats.total.urls + stats.total.orphans).toLocaleString('en-US');
			searchDefs['CONTENT'] = templates.modern.search.home;
			searchDefs['HIGHLIGHTS'] = homeHighlightsModern;
		}
		else
			searchDefs['CONTENT'] = homeContentCompat;
	}
	else {
		const sanitizedQuery = sanitizeInject(params.get('query'), true);

		const resultSegments = [];
		if (searchResults.length > 0) {
			if (!modernMode)
				resultSegments.push('<hr>');

			// Build HTML for each result
			const resultTemplate = modernMode ? templates.modern.search.result : templates.compat.search.result;
			for (const result of searchResults.slice(0, config.resultsPerPage)) {
				const displayUrl = decodeURI(result.displayUrl);
				resultSegments.push(buildHtml(resultTemplate, {
					'LINK': `/${buildRoute('view', result.source, result.offset, null)}/${result.url.replaceAll('#', '%23')}`,
					'TITLE': result.title ?? displayUrl,
					'URL': displayUrl,
					'SOURCE': result.source + (result.orphan ? ' (orphan file)' : ''),
					'TEXT': result.content ?? '',
				}));

				if (!modernMode)
					resultSegments.push('<hr>');
			}

			const doPrevPage = page > 1 && searchResults.length > 0;
			const doNextPage = page < config.maxPage && searchResults.length == config.resultsPerPage + 1;
			const prevText = '&lt;&lt; Prev';
			const nextText = 'Next &gt;&gt;';
			const prevButton = doPrevPage ? `<a href="?${params.toString()}&page=${page - 1}">${prevText}</a>` : prevText;
			const nextButton = doNextPage ? `<a href="?${params.toString()}&page=${page + 1}">${nextText}</a>` : nextText;
			const multiplePages = doPrevPage || doNextPage;
			const displayTotal = multiplePages ? config.resultsPerPage + '+' : searchResults.length.toString();

			// Build navigation HTML
			let navigate;
			if (modernMode)
				navigate = buildHtml(templates.modern.search.navigate, {
					'TOTAL': displayTotal,
					'S': searchResults.length != 1 ? 's' : '',
					'QUERY': sanitizedQuery,
					'PREV': multiplePages ? prevButton : '',
					'NEXT': multiplePages ? nextButton : '',
				});
			else
				navigate = prevButton + ' ' + nextButton;

			// Insert navigation HTML before the search results (and if the page is displaying the maximum results, after)
			if (modernMode || multiplePages) {
				resultSegments.unshift(navigate);
				if (multiplePages && searchResults.length >= config.resultsPerPage)
					resultSegments.push(navigate);
			}

			// Insert result total header before navigation HTML in compatibility mode
			if (!modernMode)
				resultSegments.unshift(`<h2>${displayTotal} result${searchResults.length != 1 ? 's' : ''} for ${sanitizedQuery}</h2>`);
		}
		else {
			let noResults = 'No results were found for the given query.';
			if (!modernMode)
				noResults = '<p>' + noResults + '</p>';

			resultSegments.push(noResults);
		}

		searchDefs['TITLE'] = `Search results for ${sanitizedQuery}`;
		searchDefs['QUERY'] = sanitizedQuery;
		searchDefs['HEADER'] = 'Search results';
		searchDefs['CONTENT'] = resultSegments.join('\n');
		searchDefs['HIGHLIGHTS'] = '';
	}

	// Populate search source dropdown
	const sourceOptions = [];
	for (const sourceId in sources)
		sourceOptions.push(`<option value="${sourceId}"${sourceId == searchFilters.source ? ' selected' : ''}>${sourceId}</option>`);
	searchDefs['SOURCES'] = sourceOptions.join('\n');

	return buildHtml(modernMode ? templates.modern.search.main : templates.compat.search.main, searchDefs);
}

// Build navigation bar
function buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode) {
	const archiveInfo = archiveInfoSet[archiveInfoIndex];
	const archiveUrl = archiveInfo.url.replaceAll('#', '%23');
	const displayUrl = decodeURI(archiveInfo.url);

	const messages = [];
	if (isOrphan)
		messages.push('(orphan file)');
	if (archiveInfo.warn)
		messages.push('(possibly inaccurate URL)');
	if (archiveInfo.error)
		messages.push('(error page)');
	if (archiveInfo.types[0] != 'text/html')
		messages.push('(embed)');

	const splitUrl = utils.splitUrl(archiveInfo.url, isOrphan ? archiveInfo.source : null);
	if (splitUrl.length > 1 && (archiveInfo.types[0] != 'text/html' || splitUrl[splitUrl.length - 1].includes('.')))
		splitUrl.pop();
	if (isOrphan)
		splitUrl.shift();

	let navbar = '';
	if (modernMode) {
		const navbarDefs = {
			'URL': displayUrl,
			'MESSAGE': messages.map(message => `<div class="navbar-message">${message}</div>`).join('\n'),
			'SOURCEINFO': `/sources#${archiveInfo.source}`,
			'WAYBACK': !isOrphan ? `<a href="${buildWaybackLink(archiveInfo.url, archiveInfo)}" target="_blank">wayback</a>` : '',
			'LIVE': !isOrphan ? `<a href="${archiveInfo.url}" target="_blank">live</a>` : '',
			'RAW': `/${buildRoute('raw', archiveInfo.source, archiveInfo.offset, null)}/${archiveUrl}`,
			'BROWSE': `/${buildRoute('browse', isOrphan ? archiveInfo.source : null, null, flagIds)}/${splitUrl.join('/')}`,
			'INLINKS': `/${buildRoute('inlinks', archiveInfo.source, null, flagIds)}/${archiveUrl}`,
			'OPTIONS': `/${buildRoute('options', archiveInfo.source, archiveInfo.offset, flagIds)}/${archiveUrl}`,
			'RANDOM': `/${buildRoute('random', null, null, flagIds)}`,
		};

		const archiveButtons = [];
		for (let i = 0; i < archiveInfoSet.length; i++) {
			if (i != archiveInfoIndex && archiveInfoSet[i].error && !flagIds.includes('r'))
				continue;

			const url = (archiveInfoSet[i].url).replaceAll('#', '%23');
			archiveButtons.push(buildHtml(templates.modern.navbar.archive, {
				'ACTIVE': i == archiveInfoIndex ? ' class="navbar-active"' : '',
				'URL': `/${buildRoute('view', archiveInfoSet[i].source, archiveInfoSet[i].offset, flagIds)}/${url}`,
				'ICON': `/images/sources/${archiveInfoSet[i].source}.gif`,
				'SOURCE': sources[archiveInfoSet[i].source].title,
				'DATE': archiveInfoSet[i].date,
			}));
		}
		navbarDefs['ARCHIVES'] = archiveButtons.join('\n');

		const screenshots = [];
		if (!isOrphan) {
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(archiveInfo.url), 'screenshots', buildMountPath);
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (utils.getPathInfo(screenshotInfoSetPath)?.isFile) {
				const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
				for (const screenshotInfo of screenshotInfoSet) {
					const screenshotUrl = screenshotInfo.url.replaceAll('#', '%23');
					const screenshotSource = sources[screenshotInfo.source];
					screenshots.push(buildHtml(templates.modern.navbar.screenshot, {
						'IMAGE': `/${buildRoute('screenshot', screenshotInfo.source, screenshotInfo.offset, null)}/${screenshotUrl}`,
						'THUMB': `/${buildRoute('thumbnail', screenshotInfo.source, screenshotInfo.offset, null)}/${screenshotUrl}`,
						'SOURCE': screenshotSource.title,
						'DATE': screenshotSource.archiveDate,
					}));
				}
			}
		}
		navbarDefs['SCREENSHOTS'] = screenshots.join('\n');

		navbar = buildHtml(templates.modern.navbar.main, navbarDefs);
	}
	else {
		const navbarDefs = {
			'URL': displayUrl,
			'SOURCE': sources[archiveInfo.source].title,
			'DATE': archiveInfo.date,
			'MESSAGE': messages.join(' '),
			'RANDOM': `/${buildRoute('random', null, null, flagIds)}`,
			'OPTIONS': `/${buildRoute('options', archiveInfo.source, archiveInfo.offset, flagIds)}/${archiveUrl}`,
			'INLINKS': `/${buildRoute('inlinks', archiveInfo.source, null, flagIds)}/${archiveUrl}`,
			'BROWSE': `/${buildRoute('browse', isOrphan ? archiveInfo.source : null, null, flagIds)}/${splitUrl.join('/')}`,
			'RAW': `/${buildRoute('raw', archiveInfo.source, archiveInfo.offset, null)}/${archiveUrl}`,
			'LIVE': !isOrphan ? buildHtml(templates.compat.navbar.live, { 'URL': archiveInfo.url }) : '',
			'WAYBACK': !isOrphan ? buildHtml(templates.compat.navbar.wayback, { 'URL': buildWaybackLink(archiveInfo.url, archiveInfo) }) : '',
			'SOURCEINFO': `/sources#${archiveInfo.source}`,
		};

		const archiveButtons = [];
		for (let i = 0; i < archiveInfoSet.length; i++) {
			if (i != archiveInfoIndex && archiveInfoSet[i].error && !flagIds.includes('r'))
				continue;

			const url = (archiveInfoSet[i].url).replaceAll('#', '%23');
			let archiveButton = `<a href="/${buildRoute('view', archiveInfoSet[i].source, archiveInfoSet[i].offset, flagIds)}/${url}">${archiveInfoSet[i].source}</a>`;
			if (i == archiveInfoIndex)
				archiveButton = '<b>' + archiveButton + '</b>';
			archiveButtons.push(archiveButton);
		}
		navbarDefs['ARCHIVES'] = archiveButtons.join(', ');

		const screenshots = [];
		if (!isOrphan) {
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(archiveInfo.url), 'screenshots', buildMountPath);
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (utils.getPathInfo(screenshotInfoSetPath)?.isFile) {
				const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
				for (const screenshotInfo of screenshotInfoSet) {
					const screenshotUrl = screenshotInfo.url.replaceAll('#', '%23');
					const screenshotSource = sources[screenshotInfo.source];
					screenshots.push(buildHtml(templates.compat.navbar.screenshot, {
						'IMAGE': `/${buildRoute('screenshot', screenshotInfo.source, screenshotInfo.offset, null)}/${screenshotUrl}`,
						'SOURCE': screenshotSource.title,
						'DATE': screenshotSource.archiveDate,
					}));
				}
			}
		}
		navbarDefs['SCREENSHOTS'] = screenshots.join('\n');

		navbar = buildHtml(templates.compat.navbar.main, navbarDefs);
	}

	return navbar;
}

// Generate a link to the Wayback Machine
function buildWaybackLink(url, archiveInfo) {
	const timestamp = archiveInfo.date.replace(/[^\d]/g, '').substring(0, 14);
	return `http://web.archive.org/web/${timestamp}/${url}`;
}

// Safely fill HTML template with text definitions
function buildHtml(template, defs) {
	// Parse and check validity of each definition (this is the one time I wish I was using TypeScript)
	const parsedDefs = {};
	for (const field in defs) {
		const def = {};
		if (defs[field] !== null && typeof(defs[field]) == 'object') {
			def.value = defs[field].value;
			def.indent = defs[field].indent;
		}
		else {
			def.value = defs[field];
			def.indent = 'all';
		}
		def.value = (def.value ?? '').toString();
		def.indent = def.indent && ['all', 'first', 'none', 'collapse'].some(option => def.indent == option) ? def.indent : 'all';
		parsedDefs[field] = def;
	}

	const varSlices = [];
	const varExp = /(\n)?(\t+)?\{(.*?)\}/gs;
	for (let match; (match = varExp.exec(template)) !== null;) {
		const newLine = match[1] ?? '';
		const tabs = match[2] ?? '';
		const def = parsedDefs[match[3]] ?? '';

		let value;
		if (def.value == '' || def.indent == 'collapse')
			// Delete all newlines and indents preceding the variable
			value = def.value;
		else if (def.indent == 'none')
			// Delete all indents preceding the variable
			value = newLine + def.value;
		else if (def.indent == 'first')
			// Preserve indents preceding the variable but don't add indents after any newlines
			value = newLine + tabs + def.value;
		else if (def.indent == 'all')
			// Preserve indents preceding the variable and add indents after any newlines
			value = newLine + def.value.replace(/^/gm, tabs);

		varSlices.push({
			start: match.index,
			end: match.index + match[0].length,
			value: value,
		});
	}

	return replaceSlices(template, varSlices);
}

// Efficiently replace slices of a string with different values
function replaceSlices(str, slices) {
	let offset = 0;
	let newStr = '';
	for (const slice of slices.toSorted((a, b) => a.start - b.start)) {
		// This segment was consumed by a previous replacement, so skip it
		if (offset > slice.start)
			continue;

		newStr += str.substring(0, slice.start - offset) + slice.value;
		const newOffset = Math.max(slice.start, slice.end);
		str = str.substring(newOffset - offset);
		offset = newOffset;
	}

	return newStr + str;
}

// Check if the user agent suggests a somewhat recent (ie. >2019) browser
function isModernBrowser(userAgent) {
	const fieldMatch = userAgent.match(/(Chrome|Firefox|Safari)\/([\d.]+)/);
	if (fieldMatch !== null) {
		const browser = fieldMatch[1];
		const version = parseInt(fieldMatch[2], 10);
		return (browser == 'Chrome'  && version >= 80)
			|| (browser == 'Firefox' && version >= 72)
			|| (browser == 'Safari'  && version >= 604);
	}

	return false;
}

// Check if the user agent suggests an extremely old (ie. <1995) browser
function isAncientBrowser(userAgent) {
	const mozillaMatch = userAgent.match(/Mozilla\/([\d.]+)/);
	if (mozillaMatch !== null) {
		// Netscape 1.1 is the oldest version not to complain if the Content-Type header defines a charset
		// So if the version is older than that, then the browser is considered to be ancient
		const version = parseFloat(mozillaMatch[1]);
		return isNaN(version) || version < 1.1;
	}

	// Any browser not pretending to be Mozilla is definitely prehistoric
	return true;
}

// Join route segments back into a string, ie. mode[-source][_flags]
function buildRoute(modeId, sourceId, offset, flagIds) {
	let routeStr = modeId ?? '';
	if (sourceId) {
		routeStr += '-' + sourceId;
		if (offset)
			routeStr += '+' + offset;
	}
	if (flagIds)
		routeStr += '_' + flagIds;

	return routeStr;
}

// Order flags and remove duplicate/invalid flags
function cleanFlags(flagIds) {
	let newFlagIds = '';
	for (const flag of flags) {
		if (flagIds.includes(flag.id))
			newFlagIds += flag.id;
	}

	return newFlagIds;
}

// Escape characters that have the potential to enable XSS injections
function sanitizeInject(str, amp = false) {
	const charMap = {
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
	};
	if (amp)
		charMap['&'] = '&amp;';

	return str.replace(new RegExp(`[${Object.keys(charMap).join('')}]`, 'g'), m => charMap[m]);
}

// Load HTML templates into memory
function loadTemplates() {
	const templateDefs = JSON.parse(Deno.readTextFileSync('data/templates.json'));
	const templates = {
		compat: {},
		modern: {},
	};

	// Compatibility mode templates
	for (const namespace in templateDefs.compat) {
		templates.compat[namespace] = { main: Deno.readTextFileSync(`templates/${namespace}.html`) };
		for (const fragment of templateDefs.compat[namespace])
			templates.compat[namespace][fragment] = Deno.readTextFileSync(`templates/${namespace}_${fragment}.html`);
	}

	// Modern mode templates
	for (const namespace in templateDefs.modern) {
		templates.modern[namespace] = { main: Deno.readTextFileSync(`templates/modern/${namespace}.html`) };
		for (const fragment of templateDefs.modern[namespace])
			templates.modern[namespace][fragment] = Deno.readTextFileSync(`templates/modern/${namespace}_${fragment}.html`);
	}

	return templates;
}

// For compatibility mode, build the full homepage content
// For modern mode, build just the highlights because they are displayed separately from the welcome text (which is static)
function buildHomeContent() {
	const highlightsHtmlArr = [];
	for (const category in highlights) {
		highlightsHtmlArr.push(`<dt><b>${category}:</b></dt>`);

		const categoryHtmlArr = [];
		const entries = highlights[category];
		for (const name in entries) {
			const entry = entries[name];
			categoryHtmlArr.push(`<a href="/view-${entry.source}/${entry.url}">${name}</a>`);
		}

		highlightsHtmlArr.push(`<dd>${categoryHtmlArr.join(' - ')}</dd>`);
	}

	const highlightsHtml = highlightsHtmlArr.join('\n');
	return [
		buildHtml(templates.compat.search.home, {
			'TOTALENTRIES': (stats.total.urls + stats.total.orphans).toLocaleString('en-US'),
			'TOTALSOURCES': Object.keys(sources).length.toLocaleString('en-US'),
			'HIGHLIGHTS': highlightsHtml,
		}),
		buildHtml(templates.modern.search.highlights, {
			'HIGHLIGHTS': highlightsHtml,
		}),
	];
}

// Build Sources page with statistics
function buildSourcesPage() {
	const getPercentString = (part, whole) => {
		if (part == 0)
			return '';

		let percentString = ' (';
		let percent = Math.round((part / whole) * 1000) / 10;
		if (percent == 0) {
			percent = 0.1;
			percentString += '&lt;';
		}
		percentString += percent + '%)';

		return percentString;
	};

	const grandTotalNoErrors = stats.total.urls + stats.total.orphans;
	const grandTotal = grandTotalNoErrors + stats.total.errors;

	// Build information for each source
	const sourceRows = [];
	for (const sourceId in sources) {
		const source = sources[sourceId];

		const sourceGrandTotalNoErrors = stats[sourceId].urls + stats[sourceId].orphans;
		const sourceGrandTotal = sourceGrandTotalNoErrors + stats[sourceId].errors;
		const sourceStats = buildHtml(templates.compat.sources.stats, {
			'URLTOTAL': stats[sourceId].urls.toLocaleString('en-US') + getPercentString(stats[sourceId].urls, stats.total.urls),
			'ORPHANTOTAL': stats[sourceId].orphans.toLocaleString('en-US') + getPercentString(stats[sourceId].orphans, stats.total.orphans),
			'ERRORTOTAL': stats[sourceId].errors.toLocaleString('en-US') + getPercentString(stats[sourceId].errors, stats.total.errors),
			'GRANDTOTAL': sourceGrandTotal.toLocaleString('en-US') + getPercentString(sourceGrandTotal, grandTotal),
			'GRANDTOTALNOERRORS': sourceGrandTotalNoErrors.toLocaleString('en-US') + getPercentString(sourceGrandTotalNoErrors, grandTotalNoErrors),
			'SCREENSHOTTOTAL': stats[sourceId].screenshots.toLocaleString('en-US') + getPercentString(stats[sourceId].screenshots, stats.total.screenshots),
		});

		sourceRows.push(buildHtml(templates.compat.sources.source, {
			'ID': sourceId,
			'TITLE': source.title,
			'AUTHOR': source.author,
			'ARCHIVEDATE': source.useTimestamps ? stats[sourceId].from + ' to ' + stats[sourceId].to : source.archiveDate,
			'PUBLISHDATE': source.publishDate,
			'LINK': source.link,
			'DESCRIPTION': source.description,
			'INTEGRITY': source.integrity,
			'REMEDIATIONS': source.remediations,
			'STATS': { value: sourceStats, indent: 'first' },
			'PERCENT': Math.round((sourceGrandTotal / grandTotal) * 1000) / 10,
		}));
	}

	const overallStats = buildHtml(templates.compat.sources.stats, {
		'URLTOTAL': stats.total.urls.toLocaleString('en-US'),
		'ORPHANTOTAL': stats.total.orphans.toLocaleString('en-US'),
		'ERRORTOTAL': stats.total.errors.toLocaleString('en-US'),
		'GRANDTOTAL': grandTotal.toLocaleString('en-US'),
		'GRANDTOTALNOERRORS': grandTotalNoErrors.toLocaleString('en-US'),
		'SCREENSHOTTOTAL': stats.total.screenshots.toLocaleString('en-US'),
	});

	return buildHtml(templates.compat.sources.main, {
		'OVERALLSTATS': { value: overallStats, indent: 'first' },
		'SOURCES': { value: sourceRows.join('\n'), indent: 'none' },
	});
}

class ArchiveError extends Error {
	constructor(status, statusText, message, options = null) {
		super(message);
		this.name = 'ArchiveError';

		this.status = status;
		this.statusText = statusText;
		this.options = options;
	}
}

class BadRequestError extends ArchiveError {
	constructor() {
		super(
			400,
			'Bad Request',
			'The requested URL is invalid.',
		);
	}
}

class BlockedError extends ArchiveError {
	constructor() {
		super(
			403,
			'Forbidden',
			'You are not allowed to access this server.',
		);
	}
}

class BadHostError extends ArchiveError {
	constructor() {
		super(
			403,
			'Forbidden',
			'Connections through this host are not allowed.',
		);
	}
}

class NotFoundError extends ArchiveError {
	constructor() {
		super(
			404,
			'Not Found',
			'The requested URL does not exist.',
			[],
		);
	}
}

class UnarchivedError extends ArchiveError {
	constructor(url) {
		const safeUrl = sanitizeInject(url, true);
		super(
			404,
			'Unarchived URL',
			`The URL <b>${safeUrl}</b> does not exist in the archive.`,
			[`<li><a href="https://web.archive.org/web/0/${safeUrl}">Go to the Wayback Machine</a></li>`],
		);
	}
}