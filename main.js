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
const sources = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.buildPath, 'sources.json')));
const stats = JSON.parse(Deno.readTextFileSync(pathUtils.join(config.buildPath, 'stats.json')));

// Load the database
const searchDatabase = new Database(pathUtils.join(config.buildPath, 'search.sqlite'), { strict: true, readonly: true });
searchDatabase.exec('PRAGMA shrink_memory');

// Start the server
(function startServer() {
	// ...over HTTP
	Deno.serve({
		port: config.httpPort,
		hostname: config.hostName,
		onListen: serverListen,
		onError: serverError,
	}, serverHandler);

	// ...over HTTPS
	if (config.httpsPort && config.httpsCert && config.httpsKey)
		Deno.serve({
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

	// Render search page and navbar in HTML5 if user agent is considered modern
	const modernMode = config.doModernMode && isModern(userAgent);

	// Get body of request URL
	const requestPath = requestUrl.pathname.replace(/^\/+/, '');

	// Initialize response headers
	const headers = new Headers();
	headers.set('Content-Type', 'text/html; charset=UTF-8');
	headers.set('Cache-Control', 'max-age=14400');

	// Serve homepage/search results
	if (requestPath == '')
		return new Response(prepareSearch(requestUrl.searchParams, modernMode), { headers: headers });

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
	const routeMatch = routeStr.match(/^([a-z0-9]+)(?:-([a-z0-9]+))?(?:_([a-z0-9]+))?$/);
	if (routeMatch === null)
		throw new NotFoundError();

	// Extract route segments and check their validity
	let [_, modeId, sourceId, flagIds] = routeMatch;
	const mode = modes.find(mode => modeId == mode.id);
	if (mode === undefined || (!mode.hasSource && sourceId !== undefined) || (!mode.hasFlags && flagIds !== undefined) || (mode.hasUrl == (urlStr == '')))
		throw new NotFoundError();

	// If the supplied source doesn't exist, clear it so we don't have to worry about it later
	if (sourceId !== undefined && sources[sourceId] === undefined)
		sourceId = undefined;

	// Clean up and sort flag IDs
	flagIds = flagIds !== undefined ? cleanFlags(flagIds) : '';

	switch (mode.id) {
		case 'view': {
			const archiveInfoSpread = getArchiveInfo(sourceId, urlStr);
			if (archiveInfoSpread === null)
				throw new UnarchivedError(urlStr);

			const [archiveInfoSet, archiveInfoIndex, archiveDir, isOrphan] = archiveInfoSpread;
			const archiveInfo = archiveInfoSet[archiveInfoIndex];
			const archivePathInfo = getArchivePathInfo(archiveDir, flagIds, modernMode);
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

				// Build navbar slice, inserting it at the top or bottom of the page depending on if modern mode is enabled
				if (doNavbar)
					slices.push({
						start: inject.navbar[modernMode ? 'modern' : 'compat'].index,
						end: null,
						value: buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode),
					});

				// Build frame-related slices if applicable
				if (inject.frames.length > 0) {
					// If 'f' flag is supplied, build slice to remove <frameset> element and its contents
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
						sliceValue = `/${buildRoute('view', linkInject.source, linkInject.embed ? embedFlagIds : flagIds)}/${linkInject.url}`;
					else if (/^https?:/i.test(linkInject.url)) {
						if (linkInject.embed || flagIds.includes('w'))
							// Do the same as above if the 'w' flag is supplied or if the link is for embedded content
							// It's fine if the link goes nowhere - it's better than potentially loading off-site resources
							sliceValue = `/${buildRoute('view', archiveInfo.source, linkInject.embed ? embedFlagIds : flagIds)}/${linkInject.url}`;
						else
							// Otherwise, point the link to the Wayback Machine
							sliceValue = buildWaybackLink(linkInject.url, archiveInfo.source);
					}

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
				let embed;
				if (fileType.startsWith('text/') || fileType.startsWith('message/') || fileType == 'application/mbox')
					embed = buildHtml(templates.compat.embed.text, { 'TEXT': Deno.readTextFileSync(archivePathInfo.filePath) })
				else {
					if (fileType.startsWith('image/'))
						embed = templates.compat.embed.image;
					else if (fileType.startsWith('audio/'))
						embed = templates.compat.embed.audio;
					else if (fileType.startsWith('video/'))
						embed = templates.compat.embed.video;
					else
						embed = templates.compat.embed.unsupported;

					embed = buildHtml(embed, {
						'FILE': `/${buildRoute('view', archiveInfo.source, cleanFlags(flagIds + 'n'))}/${archiveInfo.url}`,
						'TYPE': fileType,
					});
				}

				// We don't need to do any fancy injection here
				const navbar = buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode);
				const html = buildHtml(templates.compat.embed.main, {
					'URL': archiveInfo.url,
					'STYLE': modernMode ? '<link rel="stylesheet" href="/styles/navbar.css">' : '',
					'COMPATNAVBAR': !modernMode ? navbar : '',
					'EMBED': embed,
					'MODERNNAVBAR': modernMode ? navbar : '',
				});

				return new Response(html, { headers: headers });
			}
			else {
				// Plainly serve the file if the navbar is disabled and it's not an HTML file
				headers.set('Content-Type', fileType + (fileType.startsWith('text/') ? '; charset=UTF-8' : ''));
				return new Response(Deno.openSync(archivePathInfo.filePath).readable, { headers: headers });
			}
		}
		case 'raw': {
			const archiveInfoSpread = getArchiveInfo(sourceId, urlStr);
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
		case 'inlinks': {
			let inlinks, displayUrl;

			// Check inlinks_urls and inlinks_orphans directories for list of inlinks
			const sanitizedUrl = utils.sanitizeUrl(urlStr);
			let inlinksDir = utils.getArchiveRootDir(sanitizedUrl, 'inlinks_urls');
			let inlinksPath = pathUtils.join(inlinksDir, 'inlinks.json');
			if (utils.getPathInfo(inlinksPath)?.isFile) {
				inlinks = JSON.parse(Deno.readTextFileSync(inlinksPath));
				displayUrl = sanitizedUrl;
			}
			else if (sourceId !== null) {
				const sanitizedPath = utils.sanitizePath(urlStr);
				inlinksDir = utils.getArchiveRootDir(pathUtils.join(sourceId, sanitizedPath), 'inlinks_orphans');
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
						'LINK': `/${buildRoute('view', inlink.source, flagIds)}/${inlink.url}`,
						'ORIGINAL': inlink.url,
						'SOURCE': inlink.source,
					}));

				content = buildHtml(templates.compat.inlinks.list, { 'LINKS': links.join('\n') });
			}
			else {
				content = 'There are no links to this URL.';
				displayUrl = sanitizeInject(sanitizedUrl);
			}

			const inlinksPage = buildHtml(templates.compat.inlinks.main, {
				'URL': displayUrl,
				'CONTENT': content,
			});
			return new Response(inlinksPage, { headers: headers });
		}
		case 'options': {
			const archiveInfoSpread = getArchiveInfo(sourceId, urlStr);
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
					'OPTIONURL': `/${buildRoute('options', archiveInfo.source, newFlagIds)}/${archiveInfo.url}`,
					'FILL': checked != flag.invert ? '*' : '&nbsp;&nbsp;',
					'DESCRIPTION': flag.description,
				}));
			}

			const options = buildHtml(templates.compat.options.main, {
				'OPTIONS': optionsList.join('\n'),
				'ARCHIVEURL': `/${buildRoute('view', archiveInfo.source, flagIds)}/${archiveInfo.url}`,
			});
			return new Response(options, { headers: headers });
		}
		case 'screenshot':
		case 'thumbnail': {
			// Check if the screenshot exists
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(urlStr), 'screenshots');
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (!utils.getPathInfo(screenshotInfoSetPath)?.isFile)
				throw new NotFoundError();

			// Identify the desired screenshot from the set (lifted from getArchiveInfo)
			const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
			let screenshotInfoIndex = -1;
			if (screenshotInfoSet.length > 1 && sourceId !== undefined) {
				for (let i = 0; i < screenshotInfoSet.length; i++) {
					if (sourceId == screenshotInfoSet[i].source) {
						if (screenshotInfoIndex == -1)
							screenshotInfoIndex = i;
						if (screenshotInfoSet[i].url == urlStr) {
							screenshotInfoIndex = i;
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

			const randomUrl = `/${buildRoute('view', archiveInfo.source, flagIds)}/${archiveInfo.url.replaceAll('#', '%23')}`;
			if (modernMode)
				// Perform an HTTP redirect if modern mode is active
				return Response.redirect(`${requestUrl.origin}/${randomUrl}`);
			else {
				// Otherwise, return a page that instantly redirects using <meta http-equiv="refresh">
				headers.set('Cache-Control', 'no-store');
				return new Response(buildHtml(templates.compat.random.main, { 'URL': randomUrl }), { headers: headers });
			}
		}
		case 'sources': {
			const grandTotal = stats.total.urls + stats.total.orphans;

			// Build information for each source
			const sourceRows = [];
			for (const sourceId in sources) {
				const source = sources[sourceId];
				const sourceGrandTotal = stats[sourceId].urls + stats[sourceId].orphans;
				sourceRows.push(buildHtml(templates.compat.sources.source, {
					'ID': sourceId,
					'TITLE': source.title,
					'AUTHOR': source.author,
					'ARCHIVEDATE': (source.circa ? '~' : '') + source.archiveDate,
					'PUBLISHDATE': source.publishDate,
					'DESCRIPTION': source.description,
					'INTEGRITY': source.integrity,
					'LINK': source.link,
					'URLCOUNT': stats[sourceId].urls.toLocaleString('en-US'),
					'ORPHANCOUNT': stats[sourceId].orphans.toLocaleString('en-US'),
					'TOTALCOUNT': sourceGrandTotal.toLocaleString('en-US'),
					'SCREENSHOTCOUNT': stats[sourceId].screenshots.toLocaleString('en-US'),
					'PERCENT': Math.round((sourceGrandTotal / grandTotal) * 1000) / 10,
				}));
			}

			const sourcesPage = buildHtml(templates.compat.sources.main, {
				'URLTOTAL': stats.total.urls.toLocaleString('en-US'),
				'ORPHANTOTAL': stats.total.orphans.toLocaleString('en-US'),
				'GRANDTOTAL': grandTotal.toLocaleString('en-US'),
				'SCREENSHOTTOTAL': stats.total.screenshots.toLocaleString('en-US'),
				'SOURCES': sourceRows.join('\n'),
			});
			return new Response(sourcesPage, { headers: headers });
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

	return new Response(errorPage, { status: status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
}

// Build home/search pages based on query strings
function prepareSearch(params, modernMode) {
	const searchFilters = {
		inTitle: !params.has('in') || params.has('in', 'title'),
		inContent: !params.has('in') || params.has('in', 'content'),
		inUrl: !params.has('in') || params.has('in', 'url'),
		formatsAll: !params.has('formats') || params.get('formats') == 'all',
		formatsText: params.get('formats') == 'text',
		formatsMedia: params.get('formats') == 'media',
		source: sources[params.get('source')] !== undefined ? params.get('source') : null,
	};

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
		// Build bulleted list of sources
		const sourceTemplate = modernMode ? templates.modern.search.source : templates.compat.search.source;
		const sourceBullets = [];
		for (const sourceId in sources) {
			const source = sources[sourceId];
			sourceBullets.push(buildHtml(sourceTemplate, {
				'LINK': source.link,
				'TITLE': source.title,
				'AUTHOR': source.author,
				'DATE': (source.circa ? '~' : '') + source.archiveDate,
				'COUNT': (stats[sourceId].urls + stats[sourceId].orphans).toLocaleString('en-US'),
			}));
		}

		// Build about text
		const aboutDefs = {
			'SOURCES': sourceBullets.join('\n'),
			'TOTAL': (stats.total.urls + stats.total.orphans).toLocaleString('en-US'),
		};

		searchDefs['TITLE'] = 'Archive95';
		searchDefs['HEADER'] = 'About this website';
		searchDefs['CONTENT'] = buildHtml(modernMode ? templates.modern.search.about : templates.compat.search.about, aboutDefs);
	}
	else {
		const query = utils.safeDecode(params.get('query')).replaceAll('%', '%25');
		const sanitizedQuery = sanitizeInject(query);
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
				// Because people might be using the search bar expecting it to work like the Wayback Machine
				// (It still won't, but it at least won't always return zero results)
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

		// Parse the requested page, clamp it, and delete it from the query string so it doesn't screw up navigation button links
		const page = Math.min(config.maxPage, Math.max(1, parseInt(params.get('page'), 10) || 1));
		params.delete('page');

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

		let searchResults = [];
		try {
			// Attempt to perform the search
			// If there's an error, we just pretend there were no results
			searchResults = searchDatabase.prepare(`
				SELECT source, url, orphan,
					highlight(search, 1, '<b>', '</b>') displayUrl,
					highlight(search, 2, '<b>', '</b>') title,
					snippet(search, 3, '<b>', '</b>', '...', 24) content
				FROM search WHERE ${whereString}
				ORDER BY rank LIMIT ?2 OFFSET ?3
			`).all(parsedQuery, config.resultsPerPage + 1, (page - 1) * config.resultsPerPage);
		}
		catch {}

		const resultSegments = [];
		if (searchResults.length > 0) {
			if (!modernMode)
				resultSegments.push('<hr>');

			// Build HTML for each result
			const resultTemplate = modernMode ? templates.modern.search.result : templates.compat.search.result;
			for (const result of searchResults.slice(0, config.resultsPerPage)) {
				resultSegments.push(buildHtml(resultTemplate, {
					'LINK': `/view-${result.source}/${result.url.replaceAll('#', '%23')}`,
					'TITLE': result.title ?? result.displayUrl,
					'URL': result.displayUrl,
					'SOURCE': result.source + (result.orphan ? ' (orphan file)' : ''),
					'TEXT': result.content ?? '',
				}));

				if (!modernMode)
					resultSegments.push('<hr>');
			}

			// Build navigation buttons and result count to be inserted before (and possibly after) the results
			const doPrevPage = page > 1 && searchResults.length > 0;
			const doNextPage = page < config.maxPage && searchResults.length == config.resultsPerPage + 1;
			const multiplePages = doPrevPage || doNextPage;
			const displayTotal = multiplePages ? config.resultsPerPage + '+' : searchResults.length.toString();
			if (modernMode) {
				const prevText = '&lt;&lt; Prev';
				const nextText = 'Next &gt;&gt;';
				const navigate = buildHtml(templates.modern.search.navigate, {
					'TOTAL': displayTotal,
					'S': searchResults.length != 1 ? 's' : '',
					'QUERY': sanitizedQuery,
					'PREV': !multiplePages ? '' : (doPrevPage ? `<a href="?${params.toString()}&page=${page - 1}">${prevText}</a>` : prevText),
					'NEXT': !multiplePages ? '' : (doNextPage ? `<a href="?${params.toString()}&page=${page + 1}">${nextText}</a>` : nextText),
				});

				resultSegments.unshift(navigate);
				if (multiplePages && searchResults.length >= config.resultsPerPage)
					resultSegments.push(navigate);
			}
			else {
				if (multiplePages) {
					const prevText = 'Prev Page';
					const nextText = 'Next Page';
					const prevButton = doPrevPage ? `<a href="?${params.toString()}&page=${page - 1}">${prevText}</a>` : prevText;
					const nextButton = doNextPage ? `<a href="?${params.toString()}&page=${page + 1}">${nextText}</a>` : nextText;
					const navigate = prevButton + ', ' + nextButton;

					resultSegments.unshift(navigate);
					if (multiplePages && searchResults.length >= config.resultsPerPage)
						resultSegments.push(navigate);
				}

				resultSegments.unshift(`<h2>${displayTotal} result${searchResults.length != 1 ? 's' : ''} for ${sanitizedQuery}</h2>`);
			}
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
	}

	// Populate search source dropdown
	const sourceOptions = [];
	for (const sourceId in sources)
		sourceOptions.push(`<option value="${sourceId}"${sourceId == searchFilters.source ? ' selected' : ''}>${sourceId}</option>`);
	searchDefs['SOURCES'] = sourceOptions.join('\n');

	return buildHtml(modernMode ? templates.modern.search.main : templates.compat.search.main, searchDefs);
}

// Locate the archive in the filesystem and gather useful data
function getArchiveInfo(sourceId, url) {
	let archiveInfoSet, archiveInfoIndex, archiveDir, isOrphan = false;

	// Check the urls directory first
	let archiveRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(url), 'urls');
	let archiveInfoSetPath = pathUtils.join(archiveRootDir, 'archives.json');
	if (utils.getPathInfo(archiveInfoSetPath)?.isFile) {
		// The archive exists in the urls directory, now identify where it resides in the set
		archiveInfoSet = JSON.parse(Deno.readTextFileSync(archiveInfoSetPath));
		archiveInfoIndex = -1;
		if (archiveInfoSet.length > 1 && sourceId !== undefined) {
			for (let i = 0; i < archiveInfoSet.length; i++) {
				// If the source matches, designate as the desired archive but keep searching for an exact URL match
				if (sourceId == archiveInfoSet[i].source) {
					if (archiveInfoIndex == -1)
						archiveInfoIndex = i;
					if (archiveInfoSet[i].url == url) {
						// An exact URL match was found, let's get out of here
						archiveInfoIndex = i;
						break;
					}
				}
			}
		}
		if (archiveInfoIndex == -1)
			archiveInfoIndex = 0;

		const archiveInfo = archiveInfoSet[archiveInfoIndex];
		archiveDir = pathUtils.join(archiveRootDir, archiveInfoIndex.toString().padStart(2, '0') + '_' + archiveInfo.source);
	}
	else if (sourceId !== undefined) {
		// If a source was provided, check the orphans directory if nothing was found in the urls directory
		archiveRootDir = utils.getArchiveRootDir(pathUtils.join(sourceId, utils.sanitizePath(url)), 'orphans');
		archiveInfoSetPath = pathUtils.join(archiveRootDir, 'orphan.json');
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
function getArchivePathInfo(archiveDir, flagIds, modernMode) {
	const archivePathInfo = {
		filePath: pathUtils.join(archiveDir, 'file'),
		injectPath: pathUtils.join(archiveDir, 'inject.json'),
		typeIndex: 0,
	};

	if (!flagIds.includes('p')) {
		const filePath_p = archivePathInfo.filePath + '_p';
		const injectPath_p = pathUtils.join(archiveDir, 'inject_p.json');
		if (utils.getPathInfo(filePath_p)?.isFile) {
			archivePathInfo.filePath = filePath_p;
			archivePathInfo.injectPath = injectPath_p;
			archivePathInfo.typeIndex = 1;
			if (!modernMode) {
				const filePath_pc = filePath_p + 'c';
				const injectPath_pc = pathUtils.join(archiveDir, 'inject_pc.json');
				if (utils.getPathInfo(filePath_pc)?.isFile) {
					archivePathInfo.filePath = filePath_pc;
					archivePathInfo.injectPath = injectPath_pc;
					archivePathInfo.typeIndex = 2;
				}
			}
		}
	}

	return archivePathInfo;
}

// Build navigation bar
function buildNavbar(archiveInfoSet, archiveInfoIndex, flagIds, isOrphan, modernMode) {
	const archiveInfo = archiveInfoSet[archiveInfoIndex];
	const archiveUrl = archiveInfo.url.replaceAll('#', '%23');

	let navbar = '';
	if (modernMode) {
		const navbarDefs = {
			'URL': archiveInfo.url,
			'ORPHAN': isOrphan ? '<div class="navbar-orphan">(orphan file)</div>' : '',
			'WARNING': archiveInfo.warn ? '<div class="navbar-warning">(possibly inaccurate URL)</div>' : '',
			'SOURCEINFO': `/sources#${archiveInfo.source}`,
			'WAYBACK': !isOrphan ? `<a href="${buildWaybackLink(archiveInfo.url, archiveInfo.source)}" target="_blank">wayback</a>` : '',
			'LIVE': !isOrphan ? `<a href="${archiveInfo.url}" target="_blank">live</a>` : '',
			'RAW': `/${buildRoute('raw', archiveInfo.source, null)}/${archiveUrl}`,
			'INLINKS': `/${buildRoute('inlinks', archiveInfo.source, flagIds)}/${archiveUrl}`,
			'OPTIONS': `/${buildRoute('options', archiveInfo.source, flagIds)}/${archiveUrl}`,
			'RANDOM': `/${buildRoute('random', null, flagIds)}`,
		};

		const archiveButtons = [];
		for (let i = 0; i < archiveInfoSet.length; i++) {
			const source = sources[archiveInfoSet[i].source];
			const url = (archiveInfoSet[i].url).replaceAll('#', '%23');
			archiveButtons.push(buildHtml(templates.modern.navbar.archive, {
				'ACTIVE': i == archiveInfoIndex ? ' class="navbar-active"' : '',
				'URL': `/${buildRoute('view', archiveInfoSet[i].source, flagIds)}/${url}`,
				'ICON': `/images/sources/${archiveInfoSet[i].source}.gif`,
				'SOURCE': source.title,
				'DATE': (source.circa ? '~' : '') + source.archiveDate,
			}));
		}
		navbarDefs['ARCHIVES'] = archiveButtons.join('\n');

		const screenshots = [];
		if (!isOrphan) {
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(archiveInfo.url), 'screenshots');
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (utils.getPathInfo(screenshotInfoSetPath)?.isFile) {
				const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
				for (const screenshotInfo of screenshotInfoSet) {
					const screenshotUrl = screenshotInfo.url.replaceAll('#', '%23');
					const screenshotSource = sources[screenshotInfo.source];
					screenshots.push(buildHtml(templates.modern.navbar.screenshot, {
						'IMAGE': `/${buildRoute('screenshot', screenshotInfo.source, null)}/${screenshotUrl}`,
						'THUMB': `/${buildRoute('thumbnail', screenshotInfo.source, null)}/${screenshotUrl}`,
						'SOURCE': screenshotSource.title,
						'DATE': (screenshotSource.circa ? '~' : '') + screenshotSource.archiveDate,
					}));
				}
			}
		}
		navbarDefs['SCREENSHOTS'] = screenshots.join('\n');

		navbar = buildHtml(templates.modern.navbar.main, navbarDefs);
	}
	else {
		const source = sources[archiveInfo.source];
		const navbarDefs = {
			'RANDOM': `/${buildRoute('random', null, flagIds)}`,
			'OPTIONS': `/${buildRoute('options', archiveInfo.source, flagIds)}/${archiveUrl}`,
			'INLINKS': `/${buildRoute('inlinks', archiveInfo.source, flagIds)}/${archiveUrl}`,
			'SOURCEINFO': `/sources#${archiveInfo.source}`,
			'WAYBACK': !isOrphan ? buildHtml(templates.compat.navbar.wayback, { 'URL': buildWaybackLink(archiveInfo.url, archiveInfo.source) }) : '',
			'LIVE': !isOrphan ? buildHtml(templates.compat.navbar.live, { 'URL': archiveInfo.url }) : '',
			'RAW': `/${buildRoute('raw', archiveInfo.source, null)}/${archiveUrl}`,
			'URL': archiveInfo.url,
			'SOURCE': source.title,
			'DATE': (source.circa ? '~' : '') + source.archiveDate,
		};

		const archiveButtons = [];
		for (let i = 0; i < archiveInfoSet.length; i++) {
			const url = (archiveInfoSet[i].url).replaceAll('#', '%23');
			let archiveButton = `<a href="/${buildRoute('view', archiveInfoSet[i].source, flagIds)}/${url}">${archiveInfoSet[i].source}</a>`;
			if (i == archiveInfoIndex)
				archiveButton = '<b>' + archiveButton + '</b>';
			archiveButtons.push(archiveButton);
		}
		navbarDefs['ARCHIVES'] = archiveButtons.join(', ');

		const screenshots = [];
		if (!isOrphan) {
			const screenshotRootDir = utils.getArchiveRootDir(utils.sanitizeUrl(archiveInfo.url), 'screenshots');
			const screenshotInfoSetPath = pathUtils.join(screenshotRootDir, 'screenshots.json');
			if (utils.getPathInfo(screenshotInfoSetPath)?.isFile) {
				const screenshotInfoSet = JSON.parse(Deno.readTextFileSync(screenshotInfoSetPath));
				for (const screenshotInfo of screenshotInfoSet) {
					const screenshotUrl = screenshotInfo.url.replaceAll('#', '%23');
					const screenshotSource = sources[screenshotInfo.source];
					screenshots.push(buildHtml(templates.compat.navbar.screenshot, {
						'IMAGE': `/${buildRoute('screenshot', screenshotInfo.source, null)}/${screenshotUrl}`,
						'SOURCE': screenshotSource.title,
						'DATE': (screenshotSource.circa ? '~' : '') + screenshotSource.archiveDate,
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
function buildWaybackLink(url, sourceId) {
	const dateStr = sources[sourceId].archiveDate;
	const date = new Date(dateStr);

	const year = date.getUTCFullYear().toString();
	const month = dateStr.length > 4 ? (date.getUTCMonth() + 1).toString() : '';
	const timestamp = year + (month && month.padStart(2, '0'));

	return `http://web.archive.org/web/${timestamp}/${url}`;
}

// Safely fill HTML template with text definitions
function buildHtml(template, defs) {
	const varSlices = [];
	const varExp = /(?:(^|\n)(\t*))?\{(.*?)\}/gs;
	for (let match; (match = varExp.exec(template)) !== null;) {
		const value = defs[match[3]].toString();
		const newLine = match[1] ?? '';
		const tabs = match[2] ?? '';
		const formattedValue = value ? newLine + value.replace(/^/gm, tabs) : '';
		varSlices.push({
			start: match.index,
			end: match.index + match[0].length,
			value: formattedValue,
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

// Make an educated guess of the requesting browser's recency
function isModern(userAgent) {
	const fieldMatch = userAgent.match(/(?:Chrome|Firefox|Safari)\/[0-9.]+/);
	if (fieldMatch !== null) {
		const splitField = fieldMatch[0].split('/');
		const browser = {
			name: splitField[0],
			version: parseInt(splitField[1], 10),
		};
		return (browser.name == 'Chrome'  && browser.version >= 80)
			|| (browser.name == 'Firefox' && browser.version >= 72)
			|| (browser.name == 'Safari'  && browser.version >= 604);
	}

	return false;
}

// Join route segments back into a string, ie. mode[-source][_flags]
function buildRoute(modeId, sourceId, flagIds) {
	let routeStr = modeId ?? '';
	if (sourceId)
		routeStr += '-' + sourceId;
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
function sanitizeInject(str) {
	const charMap = {
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
	};

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
		const safeUrl = sanitizeInject(utils.safeDecode(url));
		super(
			404,
			'Unarchived URL',
			`The URL <b>${safeUrl}</b> does not exist in the archive.`,
			[`<li><a href="https://web.archive.org/web/0/${safeUrl}">Go to the Wayback Machine</a></li>`],
		);
	}
}