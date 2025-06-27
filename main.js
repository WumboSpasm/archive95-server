import { createHash } from "node:crypto";
import { Database } from "jsr:@db/sqlite@0.12";
import { join as joinPath } from "jsr:@std/path";
import { parseArgs } from "jsr:@std/cli/parse-args";

const args = parseArgs(Deno.args, {
	boolean: ["build", "wipe-cache"],
	string: ["config"],
	default: { "build": false, "wipe-cache": false, "config": "archive95.json" }
});

/*----------------------------+
 | Important Global Constants |
 +----------------------------*/

const config = {
	httpPort: 8989,
	httpsPort: 8990,
	httpsCert: "",
	httpsKey: "",
	accessHosts: [],
	blockedIPs: [],
	blockedUAs: [],
	dataPath: "data",
	logFile: "archive95.log",
	logToConsole: true,
	logBlockedRequests: true,
	doCaching: false,
	doCompatMode: true,
	forceCompatMode: false,
	resultsPerPage: 50,
	doInlinks: true,
};

const staticFiles = [
	["logo.gif", "image/gif"],
	["dice.gif", "image/gif"],
	["compat/logo.gif", "image/gif"],
	["compat/dice.gif", "image/gif"],
	["compat/options.gif", "image/gif"],
	["compat/random.gif", "image/gif"],
	["compat/home.gif", "image/gif"],
	["compat/screenshot.gif", "image/gif"],
	["banners/flashpoint.gif", "image/gif"],
	["banners/discmaster.gif", "image/gif"],
	["banners/theoldnet.gif", "image/gif"],
	["banners/anybrowser.gif", "image/gif"],
	["search.css", "text/css"],
	["navbar.css", "text/css"],
	["presentation.css", "text/css"],
];

const templates = {
	search: {
		main: getTemplate("search.html"),
		about: getTemplate("search_about.html"),
		source: getTemplate("search_source.html"),
		result: getTemplate("search_result.html"),
		navigate: getTemplate("search_navigate.html"),
		compat: {
			main: getTemplate("compat/search.html"),
			about: getTemplate("compat/search_about.html"),
			source: getTemplate("compat/search_source.html"),
			result: getTemplate("compat/search_result.html"),
		},
	},
	sources: {
		main: getTemplate("sources.html"),
		source: getTemplate("sources_source.html"),
	},
	navbar: {
		main: getTemplate("navbar.html"),
		archive: getTemplate("navbar_archive.html"),
		screenshot: getTemplate("navbar_screenshot.html"),
		compat: {
			main: getTemplate("compat/navbar.html"),
			screenshot: getTemplate("compat/navbar_screenshot.html"),
		},
	},
	embed: {
		main: getTemplate("embed.html"),
		text: getTemplate("embed_text.html"),
		image: getTemplate("embed_image.html"),
		audio: getTemplate("embed_audio.html"),
		video: getTemplate("embed_video.html"),
		unsupported: getTemplate("embed_unsupported.html"),
	},
	options: {
		main: getTemplate("options.html"),
		option: getTemplate("options_option.html"),
	},
	inlinks: {
		main: getTemplate("inlinks.html"),
		link: getTemplate("inlinks_link.html"),
		error: getTemplate("inlinks_error.html"),
	},
	error: {
		archive: getTemplate("error_archive.html"),
		generic: getTemplate("error_generic.html"),
		server: getTemplate("error_server.html"),
	},
};

const pageModes = [
	{
		id: "view",
		hasSource: true,
		hasFlags: true,
		hasUrl: true,
		doCache: true,
	},
	{
		id: "orphan",
		hasSource: true,
		hasFlags: true,
		hasUrl: true,
		doCache: true,
	},
	{
		id: "raw",
		hasSource: true,
		hasFlags: false,
		hasUrl: true,
		doCache: true,
	},
	{
		id: "inlinks",
		hasSource: false,
		hasFlags: true,
		hasUrl: true,
		doCache: false, // We actually do caching, but only after the URL is processed first
	},
	{
		id: "options",
		hasSource: true,
		hasFlags: true,
		hasUrl: true,
		doCache: true,
	},
	{
		id: "random",
		hasSource: true,
		hasFlags: true,
		hasUrl: false,
		doCache: false,
	},
	{
		id: "sources",
		hasSource: false,
		hasFlags: false,
		hasUrl: false,
		doCache: false,
	},
	{
		id: "screenshots",
		hasSource: false,
		hasFlags: false,
		hasUrl: true,
		doCache: true,
	},
	{
		id: "thumbnails",
		hasSource: false,
		hasFlags: false,
		hasUrl: true,
		doCache: true,
	},
];

const pageFlags = [
	{
		id: "n",
		description: "Show navigation bar",
		invert: true,
		hidden: false,
	},
	{
		id: "p",
		description: "Improve presentation on newer browsers",
		invert: true,
		hidden: false,
	},
	{
		id: "f",
		description: "Force frameless version of pages",
		invert: false,
		hidden: false,
	},
	{
		id: "w",
		description: "Point unarchived URLs to Wayback Machine",
		invert: true,
		hidden: false,
	},
	{
		id: "e",
		description: "Point all URLs to live internet",
		invert: false,
		hidden: true,
	},
	{
		id: "m",
		description: "Random button includes non-text files",
		invert: false,
		hidden: false,
	},
	{
		id: "o",
		description: "Random button includes orphans",
		invert: false,
		hidden: false,
	},
];

const databasePath = joinPath(config.dataPath, "archive95.sqlite");
const cachePath = joinPath(config.dataPath, "cache");

const linkExp = /((?:href|src|action|background) *= *)("(?:(?!>).)*?"|[^ >]+)/gis;
const baseExp = /<base\s+h?ref *= *("(?:(?!>).)*?"|[^ >]+)/is;

// Load config file if found
if (await validPath(args["config"])) {
	Object.assign(config, JSON.parse(await Deno.readTextFile(args["config"])));
	logMessage(`loaded config file: ${await Deno.realPath(args["config"])}`);
}

/*----------------+
 | Build Database |
 +----------------*/

if (args["build"]) {
	const startTime = Date.now();

	if (args["wipe-cache"]) {
		logMessage("wiping cache...");
		await Deno.remove(cachePath, { recursive: true });
	}

	logMessage("creating new database...");
	if (await validPath(databasePath)) await Deno.remove(databasePath);
	if (await validPath(databasePath + "-shm")) await Deno.remove(databasePath + "-shm");
	if (await validPath(databasePath + "-wal")) await Deno.remove(databasePath + "-wal");
	const db = new Database(databasePath, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA shrink_memory");

	/* Sources */

	logMessage("creating sources table...");
	db.prepare(`CREATE TABLE sources (
		id TEXT NOT NULL,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		archiveDate TEXT NOT NULL,
		publishDate TEXT NOT NULL,
		description TEXT NOT NULL,
		integrity TEXT NOT NULL,
		link TEXT NOT NULL,
		year INTEGER NOT NULL,
		month INTEGER NOT NULL,
		urlMode INTEGER NOT NULL,
		sort INTEGER PRIMARY KEY
	)`).run();

	const sourceData = JSON.parse(await Deno.readTextFile(joinPath(config.dataPath, "sources.json")));

	logMessage("adding sources to database...");
	const sourceQuery = db.prepare(`INSERT INTO sources (id, title, author, archiveDate, publishDate, description, integrity, link, year, month, urlMode, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (let s = 0; s < sourceData.length; s++) {
		const source = sourceData[s];
		logMessage(`[${s + 1}/${sourceData.length}] adding source ${source.id}...`);
		sourceQuery.run(source.id, source.title, source.author, source.archiveDate, source.publishDate, source.description, source.integrity, source.link, source.year, source.month, source.urlMode, source.sort);
	}

	/* Entries, Inlinks */

	logMessage("creating files table...");
	db.prepare(`CREATE TABLE files (
		id INTEGER PRIMARY KEY,
		path TEXT NOT NULL,
		url TEXT NOT NULL,
		sanitizedUrl TEXT NOT NULL,
		source TEXT NOT NULL,
		type TEXT,
		warn INTEGER NOT NULL,
		skip INTEGER NOT NULL,
		title TEXT,
		content TEXT
	)`).run();

	if (config.doInlinks) {
		logMessage("creating links table...");
		db.prepare(`CREATE TABLE links (
			id TEXT NOT NULL,
			url TEXT NOT NULL,
			sanitizedUrl TEXT NOT NULL
		);`).run();
	}

	const entryData = await (async () => {
		// Attempt to load type cache
		await Deno.mkdir(cachePath, { recursive: true });
		const typesPath = joinPath(cachePath, "types");
		const typesList = await validPath(typesPath)
			? (await Deno.readTextFile(typesPath)).split(/[\r\n]+/g).map(typeLine => typeLine.split("\t"))
			: [];

		// Load in entry data
		const entries = [];
		let currentEntry = 0;
		for (const source of sourceData) {
			for (const entryLine of (await Deno.readTextFile(joinPath(config.dataPath, `sources/${source.id}.txt`))).split(/[\r\n]+/g)) {
				const [path, url, warn, skip] = overwriteArray(["undefined", "", "false", "false"], entryLine.split("\t"));
				const filePath = joinPath(config.dataPath, `sources/${source.id}/${path}`);
				logMessage(`[${++currentEntry}/??] loading file ${filePath}...`);
				const entry = {
					path: path,
					url: url,
					sanitizedUrl: sanitizeUrl(url),
					source: source.id,
					type: null,
					warn: warn.toLowerCase() == "true",
					skip: skip.toLowerCase() == "true",
					title: null,
					content: null,
					links: [],
				};
				if (!entry.skip) {
					const typeLine = typesList.find(typeLine => typeLine[0] == filePath);
					if (typeLine !== undefined)
						entry.type = typeLine[1];
					else {
						const t = typesList.push([filePath, await mimeType(filePath)]);
						entry.type = typesList[t - 1][1];
					}
					if (entry.type.startsWith("text/")) {
						const text = await getText(filePath, entry.source);
						if (entry.type == "text/html") {
							const html = improvePresentation(genericizeMarkup(text, entry));
							Object.assign(entry, textContent(html));
							if (config.doInlinks) entry.links = getLinks(html, entry.url);
						}
						else
							entry.content = text
								.replaceAll("<", "&lt;").replaceAll(">", "&gt;")
								.replaceAll(/\s+/g, " ").trim();
					}
				}
				entries.push(entry);
			}
		}

		// Write type cache
		Deno.writeTextFile(joinPath(cachePath, "types"), typesList.map(typeLine => typeLine.join("\t")).join("\n"));

		// Sort entries and give them IDs based on the new order
		logMessage("sorting files...");
		const sortFunctions = [
			i => !i.skip,
			i => !!i.type?.startsWith("text/"),
			i => !!i.title,
			i => i.title == "",
		];
		const sortFields = ["title", "sanitizedUrl", "path"];
		entries.sort((a, b) => {
			let compare;
			for (const func of sortFunctions)
				if ((compare = func(b) - func(a)))
					return compare;
			for (const field of sortFields)
				if (a[field] && b[field] && (compare = a[field].localeCompare(b[field], "en", { sensitivity: "base" })))
					return compare;
			return 0;
		});
		entries.forEach((entry, e) => Object.assign(entry, { id: e }));

		return entries;
	})();

	logMessage("adding files to database...");
	const fileQuery = db.prepare("INSERT INTO files (id, path, url, sanitizedUrl, source, type, warn, skip, title, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const linkQuery = db.prepare("INSERT INTO links (id, url, sanitizedUrl) VALUES (?, ?, ?)");
	for (let e = 0; e < entryData.length; e++) {
		const entry = entryData[e];
		logMessage(`[${e + 1}/${entryData.length}] adding file sources/${entry.source}/${entry.path}...`);
		fileQuery.run(entry.id, entry.path, safeDecode(entry.url), entry.sanitizedUrl, entry.source, entry.type, entry.warn, entry.skip, entry.title, entry.content);
		if (config.doInlinks) {
			const parsedLinks = resolveLinks(
				entry, sourceData.find(source => source.id == entry.source).urlMode,
				entry.links, entryData
			);
			for (const link of parsedLinks)
				linkQuery.run(link.id, safeDecode(link.url), link.sanitizedUrl);
		}
	}

	logMessage("creating files_brief view...");
	db.prepare(`CREATE VIEW files_brief AS
		SELECT id, path, url, sanitizedUrl, source, type, warn FROM files WHERE skip = 0
	`).run();

	/* Screenshots */

	logMessage("creating screenshots table...");
	db.prepare(`CREATE TABLE screenshots (
		path TEXT NOT NULL,
		url TEXT NOT NULL,
		sanitizedUrl TEXT NOT NULL
	)`).run();

	const screenshotData = (await Deno.readTextFile(joinPath(config.dataPath, "screenshots.txt"))).split(/[\r\n]+/g).map((screenshot, s, data) => {
		screenshot = screenshot.split("\t");
		logMessage(`[${s + 1}/${data.length}] loading screenshot ${screenshot[0]}...`);
		return { url: screenshot[1], sanitizedUrl: sanitizeUrl(screenshot[1]), path: screenshot[0] };
	});

	logMessage("adding screenshots to database...");
	const screenshotQuery = db.prepare("INSERT INTO screenshots (path, url, sanitizedUrl) VALUES (?, ?, ?)");
	for (let s = 0; s < screenshotData.length; s++) {
		const screenshot = screenshotData[s];
		logMessage(`[${s + 1}/${screenshotData.length}] adding screenshot ${screenshot.path}...`);
		screenshotQuery.run(screenshot.path, safeDecode(screenshot.url), screenshot.sanitizedUrl);
	}

	const timeElapsed = Date.now() - startTime;
	const secondsElapsed = Math.floor(timeElapsed / 1000);
	const minutesElapsed = Math.floor(secondsElapsed / 60);
	const hoursElapsed = Math.floor(minutesElapsed / 60);
	logMessage(`built database in ${hoursElapsed} hours, ${minutesElapsed % 60} minutes, and ${secondsElapsed % 60} seconds`);

	db.close();
	Deno.exit();
}

/*-----------------------+
 | Server Initialization |
 +-----------------------*/

logMessage("initializing database...");
const db = new Database(databasePath, { strict: true, readonly: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA shrink_memory");

const sourceInfo = db.prepare(`
	SELECT sources.*,
		SUM(CASE WHEN url != '' THEN 1 ELSE 0 END) as urlCount,
		SUM(CASE WHEN url == '' THEN 1 ELSE 0 END) AS orphanCount,
		COUNT() AS totalCount
	FROM files_brief LEFT JOIN sources ON sources.id = source
	GROUP BY source ORDER BY sources.sort
`).all();

const serverHandler = async (request, info) => {
	const ipAddress = info.remoteAddr.hostname;
	const userAgent = request.headers.get("User-Agent") ?? "";

	// Check if IP or user agent is in blocklist
	const blockRequest =
		config.blockedIPs.some(blockedIP => ipAddress.startsWith(blockedIP)) ||
		config.blockedUAs.some(blockedUA => userAgent.includes(blockedUA));

	// Log the request if desired
	if (!blockRequest || config.logBlockedRequests)
		logMessage(`${blockRequest ? "BLOCKED " : ""}${ipAddress} (${userAgent}): ${request.url}`);

	// If request needs to be blocked, wait 10 seconds before returning a dummy page
	if (blockRequest) {
		await new Promise(resolve => setTimeout(resolve, 10000));
		return new Response("Hello, world!", { headers: { "Content-Type": "text/html" } });
	}

	// Make sure request is for a valid URL
	const requestUrl = URL.parse(request.url);
	if (requestUrl === null) throw new Error();

	// If access host is configured, do not allow connections through any other hostname
	// (ancient browsers that do not send the Host header are exempt from this rule)
	if (config.accessHosts.length > 0 && !config.accessHosts.some(host => host == requestUrl.hostname)
	&& (!(config.forceCompatMode || config.doCompatMode) || request.headers.has("Host")))
		throw new Error();

	// Render search page and navbar in basic markup if user agent is not considered modern
	const compatMode = config.forceCompatMode || config.doCompatMode && !isModern(userAgent);

	// Get body of request URL
	let requestPath = requestUrl.pathname.replace(/^\/+/, "");

	// Serve homepage/search results
	if (requestPath == "")
		return new Response(await prepareSearch(requestUrl.searchParams, compatMode), { headers: { "Content-Type": "text/html;charset=utf-8" } });

	// Serve static files
	for (const file of staticFiles.concat(sourceInfo.map(source => [`sources/${source.id}.gif`, "image/gif"])))
		if (requestPath == file[0])
			return new Response(await getFileStream("static/" + file[0]), { headers: { "Content-Type": file[1] } });

	// Append query string to request path
	requestPath += (!requestUrl.search && request.url.endsWith("?")) ? "?" : requestUrl.search;

	// Extract information from the request
	const query = parseQuery(requestPath, compatMode);
	if (query === null) return error();

	// If enabled, check the cache for file data corresponding to the request and return it if possible
	if (config.doCaching && pageModes.find(mode => mode.id == query.mode).doCache) {
		const cacheResponse = await serveFromCache(query);
		if (cacheResponse !== null) return cacheResponse;
	}

	switch (query.mode) {
		case "view": {
			const [archives, desiredArchive] = getArchives(query);
			if (archives.length == 0) return error(query.url);

			const entry = archives[desiredArchive];
			const filePath = getArchivePath(entry);

			// Once the actual entry URL is known, check the cache one more time
			query.source = entry.source;
			query.url = entry.url;
			if (config.doCaching) {
				const cacheResponse = await serveFromCache(query);
				if (cacheResponse !== null) return cacheResponse;
			}

			if (entry.type != "text/html") {
				// For non-HTML files, serve an embed instead of the actual file if the navbar is enabled
				if (!query.flags.includes("n")) {
					const plaintext = entry.type.startsWith("text/") || entry.type.startsWith("message/") || entry.type == "application/mbox";
					let embed = (
						plaintext ? templates.embed.text : (
						entry.type.startsWith("image/") ? templates.embed.image : (
						entry.type.startsWith("audio/") ? templates.embed.audio : (
						entry.type.startsWith("video/") ? templates.embed.video : (
						templates.embed.unsupported
					)))));

					if (plaintext)
						embed = embed.replace("{TEXT}", await getText(filePath, entry.source));
					else
						embed = embed
							.replaceAll("{FILE}", `/${joinArgs("view", entry.source, query.flags + "n")}/${entry.url}`)
							.replaceAll("{TYPE}", entry.type);

					let embedContainer = templates.embed.main
						.replace("{URL}", entry.sanitizedUrl)
						.replace("{EMBED}", embed);
					embedContainer = injectNavbar(embedContainer, archives, desiredArchive, query.flags);

					return await cacheAndServe(query, embedContainer, "text/html;charset=utf-8");
				}
				else {
					const [file, contentType, isModified] = await prepareMedia(filePath, entry, query.flags);
					return await cacheAndServe(query, file, contentType, isModified ? undefined : filePath);
				}
			}

			return await cacheAndServe(query, await prepareHtml(filePath, archives, desiredArchive, query), "text/html;charset=utf-8");
		}
		case "orphan": {
			const [archives, desiredArchive] = getArchives(query);
			if (archives.length == 0) return error();

			const entry = archives[desiredArchive];
			const filePath = getArchivePath(entry);

			if (entry.type != "text/html") {
				const [file, contentType, isModified] = await prepareMedia(filePath, entry, query.flags);
				return await cacheAndServe(query, file, contentType, isModified ? undefined : filePath);
			}

			return await cacheAndServe(query, await prepareHtml(filePath, archives, desiredArchive, query), "text/html;charset=utf-8");
		}
		case "raw": {
			const [archives, desiredArchive] = getArchives(query);
			if (archives.length == 0) return error();

			const entry = archives[desiredArchive];
			return await cacheAndServe(query, await Deno.readFile(getArchivePath(entry)), entry.type, getArchivePath(entry));
		}
		case "inlinks": {
			if (!config.doInlinks) return error();

			// Sanitize the URL and check if it exists in the cache
			query.url = sanitizeUrl(query.url);
			if (config.doCaching) {
				const cacheResponse = await serveFromCache(query);
				if (cacheResponse !== null) return cacheResponse;
			}

			const inlinkQuery = db.prepare(
				"SELECT path, files.url, files.sanitizedUrl, source FROM files LEFT JOIN links ON files.id = links.id WHERE links.sanitizedUrl = ?"
			).all(query.url);
			if (inlinkQuery.length == 0)
				return new Response(templates.inlinks.error.replaceAll("{URL}", query.url), { headers: { "Content-Type": "text/html;charset=utf-8" } });

			const links = inlinkQuery.map(inlink => {
				let linkBullet = templates.inlinks.link;

				if (inlink.url)
					linkBullet = linkBullet
						.replace("{LINK}", !query.flags.includes("e")
							? `/${joinArgs("view", inlink.source, query.flags)}/${inlink.url}`
							: inlink.url)
						.replace("{ORIGINAL}", inlink.url);
				else
					linkBullet = linkBullet
						.replace("{LINK}", !query.flags.includes("e")
							? `/${joinArgs("orphan", inlink.source, query.flags.replace("n", ""))}/${inlink.path}`
							: `/${inlink.path}`)
						.replace("{ORIGINAL}", inlink.path);

				return linkBullet.replace("{SOURCE}", inlink.source);
			});

			const inlinks = templates.inlinks.main
				.replaceAll("{URL}", query.url)
				.replace("{LINKS}", links.join("\n"));
			return await cacheAndServe(query, inlinks, "text/html;charset=utf-8");
		}
		case "options": {
			if (query.source == "") return error();

			const entry = db.prepare("SELECT * FROM files_brief WHERE source = ? AND url = ?").get(query.source, query.url);
			if (entry === undefined) return error();

			// Links masquerading as checkboxes are used to alter the flags in the URL and change the destination of the return link
			// This is because the archive component of the site cannot use forms and query strings to modify the output
			const optionsList = [];
			for (const flag of pageFlags) {
				if (flag.hidden) continue;
				const checked = query.flags.includes(flag.id);
				const newFlags = checked ? query.flags.replace(flag.id, "") : query.flags + flag.id;
				optionsList.push(
					templates.options.option
						.replace("{OPTIONURL}", `/${joinArgs("options", query.source, newFlags)}/${entry.url}`)
						.replace("{FILL}", checked != flag.invert ? "*" : "&nbsp;&nbsp;")
						.replace("{DESCRIPTION}", flag.description)
				);
			}

			const options = templates.options.main
				.replace("{OPTIONS}", optionsList.join("\n"))
				.replace("{ARCHIVEURL}", `/${joinArgs("view", query.source, query.flags)}/${entry.url}`);
			return await cacheAndServe(query, options, "text/html");
		}
		case "random": {
			const entry = getRandom(query.flags, query.source);
			return Response.redirect(requestUrl.origin + (
				entry.url
					? `/${joinArgs("view", entry.source, query.flags)}/${entry.url}`
					: `/${joinArgs("orphan", entry.source, query.flags)}/${entry.path}`
			));
		}
		case "sources": {
			const urlTotal = sourceInfo.reduce((total, source) => total + source.urlCount, 0);
			const orphanTotal = sourceInfo.reduce((total, source) => total + source.orphanCount, 0);
			const grandTotal = sourceInfo.reduce((total, source) => total + source.totalCount, 0);

			const sourceRows = [];
			for (const source of sourceInfo)
				sourceRows.push(templates.sources.source
					.replace("{TITLE}", source.title)
					.replace("{AUTHOR}", source.author)
					.replace("{ARCHIVEDATE}", source.archiveDate)
					.replace("{PUBLISHDATE}", source.publishDate)
					.replace("{DESCRIPTION}", source.description)
					.replace("{INTEGRITY}", source.integrity)
					.replace("{URLCOUNT}", source.urlCount.toLocaleString())
					.replace("{ORPHANCOUNT}", source.orphanCount.toLocaleString())
					.replace("{TOTALCOUNT}", source.totalCount.toLocaleString())
					.replace("{PERCENT}", Math.round((source.totalCount / grandTotal) * 1000) / 10)
					.replaceAll("{ID}", source.id)
					.replaceAll("{LINK}", source.link)
				);

			const sourcesPage = templates.sources.main
				.replace("{URLTOTAL}", urlTotal.toLocaleString())
				.replace("{ORPHANTOTAL}", orphanTotal.toLocaleString())
				.replace("{GRANDTOTAL}", grandTotal.toLocaleString())
				.replace("{SOURCES}", sourceRows.join("\n"));
			return new Response(sourcesPage, { headers: { "Content-Type": "text/html;charset=utf-8" } });
		}
		case "screenshots": {
			const screenshot = db.prepare("SELECT path FROM screenshots WHERE path = ?").get(query.url);
			if (screenshot === undefined) return error();
			return await cacheAndServe(query, await Deno.readFile(joinPath(config.dataPath, "screenshots", screenshot.path)), "image/gif");
		}
		case "thumbnails": {
			const screenshot = db.prepare("SELECT path FROM screenshots WHERE path = ?").get(query.url);
			if (screenshot === undefined) return error();
			const thumbnail = (await new Deno.Command("convert",
				{ args: [joinPath(config.dataPath, "screenshots", screenshot.path), "-geometry", "x64", "-"], stdout: "piped" }
			).output()).stdout;
			return await cacheAndServe(query, thumbnail, "image/gif");
		}
	}

	return error();
};

const serverError = (error) => {
	let errorHtml = templates.error.server;
	let status;
	if (!error.message) {
		errorHtml = errorHtml.replace("{MESSAGE}", "Connections through this host are not allowed.");
		status = 400;
	}
	else {
		logMessage(error.stack);
		errorHtml = errorHtml.replace("{MESSAGE}", "The server had trouble processing your request.");
		status = 500;
	}
	return new Response(errorHtml, { status: status, headers: { "Content-Type": "text/html" } });
};

// Start server on HTTP, and if configured to do so, HTTPS
Deno.serve({
	port: config.httpPort,
	hostname: config.hostName,
	onError: serverError,
}, serverHandler);
if (config.httpsCert && config.httpsKey)
	try {
		Deno.serve({
			port: config.httpsPort,
			cert: Deno.readTextFileSync(config.httpsCert),
			key: Deno.readTextFileSync(config.httpsKey),
			hostName: config.hostName,
			onError: serverError,
		}, serverHandler);
	} catch {}

/*-------------------------+
 | Server Helper Functions |
 +-------------------------*/

// Escape characters that have the potential to screw with markup / enable XSS injections
const charMap = {
	"{": "&lcub;",
	"}": "&rcub;",
	'"': "&quot;",
	"$": "&dollar;",
};
const charMapExp = new RegExp(`[${Object.keys(charMap).join("")}]`, "g");
const sanitizeInject = str => str.replace(charMapExp, m => charMap[m]);

// Build home/search pages based on query strings
function prepareSearch(params, compatMode) {
	let html = !compatMode ? templates.search.main : templates.search.compat.main;

	if (params.has("query")) {
		const search = {
			inUrl: !params.has("in") || params.has("in", "url"),
			inTitle: !params.has("in") || params.has("in", "title"),
			inContent: !params.has("in") || params.has("in", "content"),
			formatsAll: !params.has("formats") || params.get("formats") == "all",
			formatsText: params.get("formats") == "text",
			formatsMedia: params.get("formats") == "media",
		};

		const queryParam = { original: safeDecode(params.get("query").replaceAll("%", "%25")) };
		queryParam.compare = queryParam.original.toLowerCase();
		queryParam.html = sanitizeInject(queryParam.original.replaceAll("&", "&amp;"));
		queryParam.search = queryParam.html.replaceAll("<", "&lt;").replaceAll(">", "&gt;");

		html = html
			.replace("{QUERY}", queryParam.html)
			.replace("{INURL}", search.inUrl ? " checked" : "")
			.replace("{INTITLE}", search.inTitle ? " checked" : "")
			.replace("{INCONTENT}", search.inContent ? " checked" : "")
			.replace("{FORMATSALL}", search.formatsAll ? " checked" : "")
			.replace("{FORMATSTEXT}", search.formatsText ? " checked" : "")
			.replace("{FORMATSMEDIA}", search.formatsMedia ? " checked" : "");

		let whereConditions = [];
		if (search.inUrl)
			whereConditions.push("url LIKE ?1");
		if (search.inTitle)
			whereConditions.push("title LIKE ?1");
		if (search.inContent)
			whereConditions.push("content LIKE ?1");

		// Escape any wildcard characters that exist in the search query
		if (/[%_^]/g.test(queryParam.compare))
			whereConditions = whereConditions.map(condition => `(${condition} ESCAPE '^')`);

		let whereString = whereConditions.join(" OR ");
		if (search.formatsText)
			whereString += " AND type LIKE 'text/%'";
		else if (search.formatsMedia)
			whereString += " AND type NOT LIKE 'text/%'";

		const lastId = parseInt(params.get("last"));
		const firstId = !lastId ? parseInt(params.get("first")) : NaN;
		const compareId = lastId || firstId || 0;

		const resultsPerPage = Math.max(5, config.resultsPerPage);
		const searchQuery = queryParam.compare.length < 3 ? [] : db.prepare(`
			SELECT id, path, url, source, title, content FROM files
			WHERE id ${lastId ? "<=" : ">="} ?2 AND skip = 0 AND (${whereString})
			ORDER BY id ${lastId ? "DESC" : "ASC"} LIMIT ${resultsPerPage + 2}
		`).all(`%${queryParam.compare.replaceAll(/([%_^])/g, '^$1')}%`, compareId);
		if (lastId) searchQuery.reverse();

		// Pages are anchored around an entry ID, either preceding or following it
		// The presence of entries exceeding the defined results per page controls the behavior of the navigation buttons
		// It's very hacky, but there shouldn't be any breakage as long as the ID in the query string isn't tampered with
		let [prevId, nextId] = [-1, -1];
		let resultStart = 0;
		if (searchQuery.length > 1) {
			if (searchQuery.length > resultsPerPage && compareId == 0)
				nextId = searchQuery[resultsPerPage - 1].id;
			else if (searchQuery.length <= resultsPerPage && firstId) {
				prevId = searchQuery[1].id;
				resultStart = 1;
			}
			else if (searchQuery.length == resultsPerPage + 1) {
				if (firstId) {
					prevId = searchQuery[1].id;
					resultStart = 1;
				}
				if (lastId)
					nextId = searchQuery[resultsPerPage - 1].id;
			}
			else if (searchQuery.length == resultsPerPage + 2) {
				prevId = searchQuery[1].id;
				nextId = searchQuery[resultsPerPage].id;
				resultStart = 1;
			}
		}

		const resultSegments = [];
		for (const result of searchQuery.slice(resultStart, resultStart + resultsPerPage)) {
			let titleInject = sanitizeInject(result.title ?? "");
			let titleMatchIndex = -1;
			if (titleInject) {
				if (search.inTitle && (titleMatchIndex = titleInject.toLowerCase().indexOf(queryParam.compare)) != -1)
					titleInject =
						titleInject.substring(0, titleMatchIndex) +
						"<b>" + titleInject.substring(titleMatchIndex, titleMatchIndex + queryParam.compare.length) + "</b>" +
						titleInject.substring(titleMatchIndex + queryParam.compare.length);
			}
			else
				titleInject = result.url || `/${result.source}/${result.path}`;

			let urlInject;
			if (result.url) {
				urlInject = sanitizeInject(result.url);
				let urlMatchIndex = -1;
				if (search.inUrl && (urlMatchIndex = urlInject.toLowerCase().indexOf(queryParam.compare)) != -1)
					urlInject =
						urlInject.substring(0, urlMatchIndex) +
						"<b>" + urlInject.substring(urlMatchIndex, urlMatchIndex + queryParam.compare.length) + "</b>" +
						urlInject.substring(urlMatchIndex + queryParam.compare.length);
			}
			else
				urlInject = result.path;

			let contentInject = result.content ?? "";
			let contentMatchIndex = -1;
			if (search.inContent && (contentMatchIndex = contentInject.toLowerCase().indexOf(queryParam.compare)) != -1) {
				const minBound = contentMatchIndex - 30;
				const maxBound = minBound + 200;
				contentInject = sanitizeInject(
					contentInject.substring(minBound, contentMatchIndex) +
					"<b>" + contentInject.substring(contentMatchIndex, contentMatchIndex + queryParam.compare.length) + "</b>" +
					contentInject.substring(contentMatchIndex + queryParam.compare.length, maxBound)
				).trim();
				if (!compatMode) {
					if (minBound > 0) contentInject = "&hellip;" + contentInject;
				}
				else {
					if (minBound > 0) contentInject = "..." + contentInject;
					if (maxBound < result.content.length) contentInject += "...";
				}
			}
			else
				contentInject = sanitizeInject(contentInject.substring(0, 200) + (compatMode && contentInject.length > 200 ? "..." : ""));

			const archiveUrl = result.url
				? `/view-${result.source}/${result.url.replaceAll("#", "%23")}`
				: `/orphan-${result.source}/${result.path.replaceAll("#", "%23")}`;
			resultSegments.push(
				(!compatMode ? templates.search.result : templates.search.compat.result)
					.replace("{ARCHIVE}", archiveUrl)
					.replace("{TITLE}", titleInject)
					.replace("{URL}", urlInject)
					.replace("{SOURCE}", result.source + (result.url ? "" : " (orphan)"))
					.replace("{TEXT}", contentInject)
			);
			if (compatMode) resultSegments.push("\t\t<hr>");
		}

		params.delete("first");
		params.delete("last");

		const totalResults = (prevId != -1 || nextId != -1) ? (resultsPerPage + "+") : searchQuery.length;
		if (!compatMode) {
			const prevText = "&lt;&lt; Prev";
			const nextText = "Next &gt;&gt;";
			const navigate = templates.search.navigate
				.replace("{TOTAL}", totalResults)
				.replace("{S}", searchQuery.length > 1 ? "s" : "")
				.replace("{QUERY}", queryParam.search)
				.replace("{PREVIOUS}", prevId == -1 ? prevText : `<a href="?${params.toString()}&last=${prevId}">${prevText}</a>`)
				.replace("{NEXT}", nextId == -1 ? nextText : `<a href="?${params.toString()}&first=${nextId}">${nextText}</a>`);

			resultSegments.unshift(navigate);
			if (nextId != -1)
				resultSegments.push(navigate);

			const resultsString = searchQuery.length == 0 ? "No results were found for the given query." : resultSegments.join("\n");
			html = html
				.replace("{HEADER}", "Search results")
				.replace("{CONTENT}", resultsString);
		}
		else {
			if (searchQuery.length > 0) {
				resultSegments.unshift("\t\t<hr>");
				if (prevId != -1 || nextId != -1) {
					const prevText = "Prev Page";
					const nextText = "Next Page";
					const prevButton = prevId == -1 ? prevText : `<a href="?${params.toString()}&last=${prevId}">${prevText}</a>`;
					const nextButton = nextId == -1 ? nextText : `<a href="?${params.toString()}&first=${nextId}">${nextText}</a>`;
					const navigate = `\t\t${prevButton}, ${nextButton}`;
					resultSegments.unshift(navigate);
					if (nextId != -1)
						resultSegments.push(navigate);
				}
			}

			resultSegments.unshift(`\t\t<h2>${totalResults} results for "${queryParam.search}"</h2>`);
			html = html.replace("{CONTENT}", resultSegments.join("\n"));
		}

		html = html.replace("{TITLE}", `Search results for "${queryParam.search}"`)
	}
	else {
		html = html
			.replace("{QUERY}", "")
			.replace("{INURL}", " checked")
			.replace("{INTITLE}", " checked")
			.replace("{INCONTENT}", " checked")
			.replace("{FORMATSALL}", " checked")
			.replace("{FORMATSTEXT}",  "")
			.replace("{FORMATSMEDIA}", "");

		const sources = [];
		for (const source of sourceInfo)
			sources.push(
				(!compatMode ? templates.search.source : templates.search.compat.source)
					.replace("{LINK}", source.link)
					.replace("{TITLE}", source.title)
					.replace("{AUTHOR}", source.author)
					.replace("{DATE}", source.archiveDate)
					.replace("{COUNT}", source.totalCount.toLocaleString())
			);

		let about = (!compatMode ? templates.search.about : templates.search.compat.about)
			.replace("{SOURCES}", sources.join("\n"))
			.replace("{TOTAL}", sourceInfo.reduce((total, source) => total + source.totalCount, 0).toLocaleString());

		if (compatMode) {
			const randomEntry = getRandom();
			about = about.replace("{RANDOM}", `/view-${randomEntry.source}/${randomEntry.url}`);
		}
		else
			html = html.replace("{HEADER}", "About this website");

		html = html
			.replace("{TITLE}", "Archive95")
			.replace("{CONTENT}", about);
	}

	return html;
}

// Load, parse, and modify HTML data according to the query
async function prepareHtml(filePath, archives, desiredArchive, query) {
	const entry = archives[desiredArchive];

	let html = await getText(filePath, entry.source);
	html = genericizeMarkup(html, entry);
	html = redirectLinks(html, entry, query.flags, getLinks(html, entry.url));

	const framesetExp = /<frameset.*?>.*<\/frameset> *\n?/is;
	const noframesExp = /<\/?no ?frames?> *\n?/gi;
	if (!framesetExp.test(html) && noframesExp.test(html))
		html = html.replace(noframesExp, '');
	else if (query.flags.includes("f"))
		html = html.replace(framesetExp, '').replace(noframesExp, '');

	if (!query.flags.includes("p"))
		html = improvePresentation(html, query.compat);
	if (query.mode == "view" && !query.flags.includes("n"))
		html = injectNavbar(html, archives, desiredArchive, query.flags, query.compat);

	return html;
}

// Load non-HTML data and make changes if necessary
async function prepareMedia(filePath, entry, flags) {
	let [data, contentType, isModified] = [null, entry.type, false];

	// Convert XBM to GIF
	if (!flags.includes("p") && entry.type == "image/x-xbitmap") {
		data = (await new Deno.Command("convert", { args: [filePath, "GIF:-"], stdout: "piped" }).output()).stdout;
		contentType = "image/gif";
		isModified = true;
	}
	// Fix problematic GIFs present in The Risc Disc Volume 2
	if (entry.source == "riscdisc" && entry.type == "image/gif") {
		data = (await new Deno.Command("convert", { args: [filePath, "+repage", "-"], stdout: "piped" }).output()).stdout;
		isModified = true;
	}

	if (data === null) data = await Deno.readFile(filePath);
	return [data, contentType, isModified];
}

// Create a response object, and cache the passed data if caching is enabled
async function cacheAndServe(query, data, contentType, symlink) {
	if (config.doCaching) {
		const [cachedFileDir, cachedFileData, cachedFileType] = getCachedFilePaths(query);
		if (!await validPath(cachedFileData)) {
			try {
				await Deno.mkdir(cachedFileDir, { recursive: true });
				if (symlink !== undefined)
					await Deno.symlink(await Deno.realPath(symlink), cachedFileData);
				else if (typeof(data) == "string")
					await Deno.writeTextFile(cachedFileData, data);
				else
					await Deno.writeFile(cachedFileData, data);
				await Deno.writeTextFile(cachedFileType, contentType);
			} catch {}
		}
	}
	return new Response(data, { headers: { "Content-Type": contentType } });
}

// Retrieve file data from the cache and create a response object
async function serveFromCache(query) {
	let cacheResponse = null;
	const [_, cachedFileData, cachedFileType] = getCachedFilePaths(query);
	if (await validPath(cachedFileData)) {
		try {
			const data = await getFileStream(cachedFileData);
			const contentType = await Deno.readTextFile(cachedFileType);
			cacheResponse = new Response(data, { headers: { "Content-Type": contentType } });
		} catch {}
	}
	return cacheResponse;
}

// Generate a file path for the given query
function getCachedFilePaths(query) {
	const queryString = `${query.mode}|${query.source}|${query.flags}|${query.url}|${query.compat ? "compat" : ""}`;
	const queryHash = createHash("sha1").update(JSON.stringify(queryString)).digest("hex");
	const cachedFileDir = joinPath(cachePath, queryHash.substring(0, 2), queryHash.substring(2, 4));
	const cachedFileData = joinPath(cachedFileDir, queryHash);
	const cachedFileType = cachedFileData + ".type";
	return [cachedFileDir, cachedFileData, cachedFileType];
}

// Point links to archives, or the original URLs if "e" flag is enabled
function redirectLinks(html, entry, flags, rawLinks) {
	const rootSource = sourceInfo.find(source => source.id == entry.source);
	const flagsNav = flags.replace("n", "");
	const flagsNoNav = flagsNav + "n";

	const unmatchedLinks = rawLinks.map(link => {
		const matchStart = link.lastIndex - link.fullMatch.length;
		const matchEnd = link.lastIndex;
		const parsedUrl = URL.parse(link.rawUrl, link.baseUrl);
		let parsedUrlStr;
		if (parsedUrl !== null)
			parsedUrlStr = parsedUrl.href;
		else {
			const parsedPath = URL.parse(link.rawUrl, "http://abc/" + entry.path);
			if (parsedPath !== null)
				parsedUrlStr = parsedPath.pathname;
			else
				return null;
		}
		return {...link,
			url: parsedUrlStr,
			sanitizedUrl: sanitizeUrl(parsedUrlStr),
			start: matchStart,
			end: matchEnd,
			isEmbedded: !/^href/i.test(link.attribute),
		};
	}).filter(link => link !== null);
	if (unmatchedLinks.length == 0) return html;

	const matchedLinks = [];

	// Filtering function to remove duplicate entries by their distance from the root source date
	const nearestEntryOnly = (entry, _, self) => {
		const rootSourceMonth = rootSource.month == 0 ? 12 : rootSource.month;
		const source  = sourceInfo.find(source => source.id == entry.source);
		const sourceMonth = source.month == 0 ? 12 : source.month;
		const monthDist  = Math.abs((rootSource.year * 12 + rootSourceMonth) - (source.year * 12 + sourceMonth));
		for (const entry2 of self)
			if (entry.sanitizedUrl == entry2.sanitizedUrl && entry.source != entry2.source) {
				const source2 = sourceInfo.find(source => source.id == entry2.source);
				const sourceMonth2 = source2.month == 0 ? 12 : source2.month;
				const monthDist2 = Math.abs((rootSource.year * 12 + rootSourceMonth) - (source2.year * 12 + sourceMonth2));
				return monthDist < monthDist2;
			}
		return true;
	};

	// Check for path matches (needed for sources that have their own filesystems)
	if (rootSource.urlMode > 0) {
		const comparePaths = [];
		const comparePathsQuery = [];
		for (const link of unmatchedLinks) {
			if (!link.hasHttp) {
				const parsedUrl = URL.parse(link.rawUrl, "http://abc/" + entry.path);
				if (parsedUrl !== null) {
					const comparePath = parsedUrl.pathname.substring(1).toLowerCase();
					comparePaths.push(comparePath + parsedUrl.hash);
					if (!comparePathsQuery.includes(comparePath + parsedUrl.hash)) {
						comparePathsQuery.push(comparePath + parsedUrl.hash);
						// Make sure database query takes into account anchored and anchorless variations of path
						if (parsedUrl.hash && !comparePathsQuery.includes(comparePath))
							comparePathsQuery.push(comparePath);
					}
					continue;
				}
			}
			comparePaths.push(null);
		}

		if (comparePaths.length > 0) {
			const entryQuery = db.prepare(`
				SELECT path, url, source, skip FROM files
				WHERE source = ? AND path COLLATE NOCASE IN (${Array(comparePathsQuery.length).fill("?").join(", ")})
			`).all(entry.source, ...comparePathsQuery).filter(nearestEntryOnly);

			for (const compareEntry of entryQuery) {
				const entryComparePath = compareEntry.path.toLowerCase();
				for (let l = 0; l < unmatchedLinks.length; l++) {
					if (comparePaths[l] === null) continue;
					const pathVariations = [comparePaths[l]];
					let pathAnchor = "";
					const anchorIndex = comparePaths[l].lastIndexOf("#");
					if (anchorIndex != -1) {
						pathVariations.push(comparePaths[l].substring(0, anchorIndex));
						pathAnchor = comparePaths[l].substring(anchorIndex);
					}
					if (pathVariations.some(path => path == entryComparePath)) {
						if (compareEntry.skip) {
							unmatchedLinks[l].url = compareEntry.url;
							unmatchedLinks[l].sanitizedUrl = sanitizeUrl(compareEntry.url);
							unmatchedLinks[l].hasHttp = true;
							continue;
						}
						const entryUrl = compareEntry.url + pathAnchor;
						if (flags.includes("e"))
							unmatchedLinks[l].url = entryUrl || `/${compareEntry.path}`;
						else if (entryUrl)
							unmatchedLinks[l].url = `/${
								joinArgs("view", entry.source, unmatchedLinks[l].isEmbedded ? flagsNoNav : flags)
							}/${entryUrl}`;
						else
							unmatchedLinks[l].url = `/${joinArgs("orphan", entry.source, flagsNav)}/${compareEntry.path}`;
						matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
						comparePaths.splice(l, 1);
						l -= 1;
					}
				}
			}
		}
	}

	if (!flags.includes("e")) {
		const compareUrls = [...new Set(unmatchedLinks.map(link => link.sanitizedUrl))];
		const entryQuery = db.prepare(`
			SELECT path, sanitizedUrl, source FROM files_brief
			WHERE sanitizedUrl IN (${Array(compareUrls.length).fill("?").join(", ")})
		`).all(...compareUrls).filter(nearestEntryOnly);

		if (entryQuery.length > 0) {
			// Check for source-local matches first
			const sourceLocalEntries = entryQuery.filter(filterEntry => filterEntry.source == entry.source);
			for (const sourceLocalEntry of sourceLocalEntries)
				for (let l = 0; l < unmatchedLinks.length; l++)
					if (sourceLocalEntry.sanitizedUrl == unmatchedLinks[l].sanitizedUrl) {
						unmatchedLinks[l].url = `/${
							joinArgs("view", entry.source, unmatchedLinks[l].isEmbedded ? flagsNoNav : flags)
						}/${unmatchedLinks[l].url}`;
						matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
						l -= 1;
					}

			// Then for matches anywhere else
			if (unmatchedLinks.length > 0) {
				const sourceExternalEntries = entryQuery.filter(filterEntry => filterEntry.source != entry.source);
				for (const sourceExternalEntry of sourceExternalEntries)
					for (let l = 0; l < unmatchedLinks.length; l++)
						if (sourceExternalEntry.sanitizedUrl == unmatchedLinks[l].sanitizedUrl) {
							unmatchedLinks[l].url = `/${
								joinArgs("view", sourceExternalEntry.source, unmatchedLinks[l].isEmbedded ? flagsNoNav : flags)
							}/${unmatchedLinks[l].url}`;
							matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
							l -= 1;
						}
			}
		}

		// Point all clickable links to the Wayback Machine, and everything else to an invalid URL
		// We shouldn't be loading any content off of Wayback
		for (let l = 0; l < unmatchedLinks.length; l++) {
			if (rootSource.urlMode == 2 && !unmatchedLinks[l].hasHttp)
				unmatchedLinks[l].url = unmatchedLinks[l].isEmbedded
					? "[unarchived-media]"
					: "[unarchived-link]";
			else if (!flags.includes("w"))
				unmatchedLinks[l].url = unmatchedLinks[l].isEmbedded
					? `/${joinArgs("view", entry.source, flagsNoNav)}/${unmatchedLinks[l].url}`
					: getWaybackLink(unmatchedLinks[l].url, rootSource.year, rootSource.month);
			else
				unmatchedLinks[l].url =
					`/${joinArgs("view", entry.source, unmatchedLinks[l].isEmbedded ? flagsNoNav : flags)}/${unmatchedLinks[l].url}`;
		}
	}

	// Update markup with new links
	let offset = 0;
	let newHtml = "";
	for (const link of unmatchedLinks.concat(matchedLinks).toSorted((a, b) => a.start - b.start)) {
		newHtml += html.substring(0, link.start - offset) + link.attribute + (link.doQuotes ? `"${link.url}"` : link.url);
		html = html.substring(link.end - offset);
		offset = link.end;
	}
	newHtml += html;

	// Remove base element if it exists
	return newHtml.replaceAll(/<base .*?>(?:.*?<\/base>)?\n?/gis, '');
}

// Display navigation bar
function injectNavbar(html, archives, desiredArchive, flags, compatMode = false) {
	// Pages with frames can't display the navigation bar
	if (/<frameset.*?>/i.test(html)) return html;

	const entry = archives[desiredArchive];
	const realUrl = entry.url.replaceAll("%23", "#");

	if (!compatMode) {
		const rootSource = sourceInfo.find(source => source.id == entry.source);
		let navbar = templates.navbar.main
			.replaceAll("{URL}", realUrl)
			.replace("{SHOWWARNING}", entry.warn ? "" : " hidden")
			.replace("{SOURCE}", `/sources#${entry.source}`)
			.replace("{SHOWINLINKS}", config.doInlinks ? "" : " hidden")
			.replace("{WAYBACK}", getWaybackLink(realUrl, rootSource.year, rootSource.month))
			.replace("{RAW}", `/${joinArgs("raw", entry.source)}/${entry.path}`)
			.replace("{INLINKS}", `/${joinArgs("inlinks", null, flags)}/${entry.url}`)
			.replace("{OPTIONS}", `/${joinArgs("options", entry.source, flags)}/${entry.url}`)
			.replace("{RANDOM}", `/${joinArgs("random", null, flags)}/`);

		const archiveButtons = [];
		for (let a = 0; a < archives.length; a++) {
			const archive = archives[a];
			const source = sourceInfo.find(source => source.id == archive.source);
			archiveButtons.push(
				templates.navbar.archive
					.replace("{ACTIVE}", a == desiredArchive ? ' class="navbar-active"' : "")
					.replace("{URL}", `/${joinArgs("view", source.id, flags)}/${archive.url}`)
					.replace("{ICON}", `/sources/${source.id}.gif`)
					.replace("{TITLE}", source.title)
					.replace("{DATE}", source.archiveDate)
			);
		}
		navbar = navbar.replace("{ARCHIVES}", archiveButtons.join("\n"));

		const screenshotQuery = db.prepare("SELECT path FROM screenshots WHERE sanitizedUrl = ?").all(entry.sanitizedUrl).map(screenshot => screenshot.path);
		if (screenshotQuery.length > 0) {
			const screenshots = [];
			for (const screenshotPath of screenshotQuery)
				screenshots.push(
					templates.navbar.screenshot
						.replace("{IMAGE}", "/screenshots/" + screenshotPath)
						.replace("{THUMB}", "/thumbnails/" + screenshotPath)
				);
			navbar = navbar.replace("{SCREENSHOTS}", screenshots.join("\n"));
		}
		else
			navbar = navbar.replace("{SCREENSHOTS}", "");

		const style = '<link rel="stylesheet" href="/navbar.css">';
		const matchHead = html.match(/<head(er)?(| .*?)>/i);
		html = matchHead !== null
			? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
			: style + "\n" + html;

		const padding = '<div style="height:120px"></div>';
		const bodyCloseIndex = blankComments(html).search(/(?:(?:<\/(?:body|noframes|html)>\s*)+)?$/i);
		html = bodyCloseIndex != -1
			? (html.substring(0, bodyCloseIndex) + padding + "\n" + navbar + "\n" + html.substring(bodyCloseIndex))
			: html + "\n" + padding + "\n" + navbar;
	}
	else {
		const source = sourceInfo.find(source => source.id == entry.source);
		const randomEntry = getRandom(flags);
		let navbar = templates.navbar.compat.main
			.replace("{URL}", realUrl)
			.replace("{SOURCE}", source.title)
			.replace("{DATE}", source.archiveDate)
			.replace("{OPTIONS}", `/${joinArgs("options", entry.source, flags)}/${entry.url}`)
			.replace("{RANDOM}", `/${joinArgs("view", randomEntry.source, flags)}/${randomEntry.url}`);

		if (archives.length > 1) {
			const archiveButtons = [];
			for (let a = 0; a < archives.length; a++)
				if (a != desiredArchive)
					archiveButtons.push(`<a href="/${joinArgs("view", archives[a].source, flags)}/${archives[a].url}">${archives[a].source}</a>`);
			navbar = navbar.replace("{ARCHIVES}", "Other archives: " + archiveButtons.join(", "));
		}
		else
			navbar = navbar.replace("{ARCHIVES}", "");

		const screenshotQuery = db.prepare("SELECT path FROM screenshots WHERE sanitizedUrl = ?").all(entry.sanitizedUrl).map(screenshot => screenshot.path);
		if (screenshotQuery.length > 0) {
			const screenshots = [];
			for (const screenshotPath of screenshotQuery)
				screenshots.push(templates.navbar.compat.screenshot.replace("{IMAGE}", "/screenshots/" + screenshotPath));
			navbar = navbar.replace("{SCREENSHOTS}", screenshots.join("\n"));
		}
		else
			navbar = navbar.replace("{SCREENSHOTS}", "");

		const bodyOpenIndex = (blankComments(html).match(
			/^(?:\s*(?:<(?:!DOCTYPE.*?|html|head(?:er)?.*?>.*?<\/head|body)>\s*)+)?/is
		) ?? [""])[0].length;
		html = html.substring(0, bodyOpenIndex) + navbar + "\n" + html.substring(bodyOpenIndex);
	}

	return html;
}

// Extract useful information from a request
function parseQuery(requestPath, compatMode) {
	const query = {
		mode: "",
		source: "",
		flags: "",
		url: "",
		compat: compatMode,
	};

	const argsStr = requestPath.substring(0, Math.max(0, requestPath.indexOf("/")) || requestPath.length);
	const argsA = argsStr.split("_");
	const argsB = argsA[0].split("-");

	const mode = pageModes.find(mode => mode.id == argsB[0]);
	if (mode === undefined) return null;
	query.mode = mode.id;

	if (mode.hasUrl) {
		const url = safeDecode(requestPath.substring(argsStr.length + 1).replace(/^\/+/, ""));
		if (url == "") return null;
		query.url = url;
	}

	if (mode.hasSource && argsB.length > 1 && sourceInfo.some(source => source.id == argsB[1]))
		query.source = argsB[1];
	if (mode.hasFlags && argsA.length > 1)
		for (const flag of pageFlags)
			if (argsA[1].includes(flag.id))
				query.flags += flag.id;

	// Treat certain flags and settings as disabled if they are redundant or not applicable to the current request
	if (query.mode != "view" || (query.mode == "orphan" && !query.flags.includes("p"))) query.compat = false;
	if (query.mode != "options" && (query.mode == "orphan" || query.flags.includes("n"))) {
		query.flags = query.flags.replaceAll(/[mo]/g, "");
		if (query.mode == "orphan") query.flags = query.flags.replace("n", "");
	}

	return query;
}

// Join arguments back into a string, ie. mode[-source][_flags]
function joinArgs(mode, source, flags) {
	let argsStr = mode ?? "";
	if (source) argsStr += "-" + source;
	if (flags) argsStr += "_" + sortFlags(flags);
	return argsStr;
}

// Sort flags in alphabetical order
function sortFlags(flags) { return flags.split("").toSorted().join(""); }

// Return all archived files for a given query
function getArchives(query) {
	let archives = [];
	let desiredArchive = 0;

	if (query.mode == "view") {
		const sanitizedUrl = sanitizeUrl(query.url);
		archives = db.prepare("SELECT * FROM files_brief WHERE sanitizedUrl = ?").all(sanitizedUrl);
		if (archives.length == 0) return [[], -1];
		if (archives.length > 1) {
			// Sort archives from oldest to newest
			archives.sort((a, b) => {
				const asort = sourceInfo.find(source => source.id == a.source).sort;
				const bsort = sourceInfo.find(source => source.id == b.source).sort;
				return asort - bsort;
			});
			// Get desired archive by first looking for exact URL match, then sanitized URL if there are no exact matches
			if (query.source) {
				desiredArchive = archives.findIndex(archive =>
					archive.source == query.source && archive.url == query.url
				);
				if (desiredArchive == -1)
					desiredArchive = archives.findIndex(archive =>
						archive.source == query.source && sanitizeUrl(archive.url) == sanitizedUrl
					);
				desiredArchive = Math.max(0, desiredArchive);
			}
		}
	}
	else if (query.mode == "orphan" || query.mode == "raw") {
		if (!query.source || !query.url) return [[], -1];
		const entry = db.prepare(`SELECT * FROM files_brief WHERE source = ? AND path = ?`).get(query.source, query.url);
		if (entry === undefined) return [[], -1];
		archives.push(entry);
	}

	// Encode number sign to make sure it's properly identified as part of the URL
	for (const archive of archives)
		archive.url = archive.url.replaceAll("#", "%23");

	return [archives, desiredArchive];
}

// Return the filesystem path for an archived file
function getArchivePath(entry) { return joinPath(config.dataPath, "sources", entry.source, entry.path); }

// Return a random entry
function getRandom(flags = "", source) {
	const whereConditions = [];
	const whereParameters = [];
	if (!flags.includes("m"))
		whereConditions.push("type = 'text/html'");
	if (!flags.includes("o"))
		whereConditions.push("sanitizedUrl != ''");
	if (source) {
		whereConditions.push("source = ?");
		whereParameters.push(source);
	}
	return db.prepare(
		`SELECT path, url, source FROM files_brief ${whereConditions.length > 0 ? ("WHERE " + whereConditions.join(" AND ")) : ""} ORDER BY random() LIMIT 1`
	).get(...whereParameters);
}

// Generate a link to the Wayback Machine
function getWaybackLink(url, year, month) {
	const timestamp = year + (month == 0 ? "" : `${month}`.padStart(2, "0"));
	return `http://web.archive.org/web/${timestamp}/${url}`;
}

// Make an educated guess of the requesting browser's recency
function isModern(userAgent) {
	const fieldMatch = userAgent.match(/(?:Chrome|Firefox|Safari)\/[0-9.]+/) ?? [];
	if (fieldMatch.length > 0) {
		const splitField = fieldMatch[0].split("/");
		const browser = {
			name: splitField[0],
			version: parseFloat(splitField[1]),
		};
		return (browser.name == "Chrome"  && browser.version >= 80)
			|| (browser.name == "Firefox" && browser.version >= 72)
			|| (browser.name == "Safari"  && browser.version >= 604);
	}
	return false;
}

// Display error page
function error(url) {
	let errorHtml, status;
	if (url) {
		url = sanitizeInject(url).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		errorHtml = templates.error.archive
			.replace("{TRIMMEDURL}", url.length > 64 ? `${url.substring(0, 64)}...` : url)
			.replace("{WAYBACKURL}", url);
		status = 404;
	}
	else {
		errorHtml = templates.error.generic;
		status = 400;
	}
	return new Response(errorHtml, { status: status, headers: { "Content-Type": "text/html" } });
}

/*------------------------+
 | Build Helper Functions |
 +------------------------*/

// Get the title and all visible text on a page
function textContent(html) {
	const titleMatch = [...html.matchAll(/<title>(((?!<\/title>).)*?)<\/title>/gis)];
	const title = titleMatch.length > 0
		? titleMatch[titleMatch.length - 1][1].replaceAll(/<.*?>/gs, " ").replaceAll(/\s+/g, " ").trim()
		: "";

	const content = html.replaceAll(
		/<title>.*?<\/title>/gis,
		"",
	).replaceAll(
		/<script(?: [^>]*)?>.*?<\/script>/gis,
		""
	).replaceAll(
		/<[^>]+alt *= *"(.*?)".*?>/gis,
		" $1 "
	).replaceAll(
		/<[^>]+alt *= *([^ >]+).*?>/gis,
		" $1 "
	).replaceAll(
		/<! *-+.*?-+ *>/gs,
		""
	).replaceAll(
		/<.*?>/gs,
		" "
	).replaceAll(
		/\s+/g,
		" "
	).trim();

	return { title: title, content: content };
}

// Get links from the given markup and return them as fully-formed URLs
function resolveLinks(entry, mode, rawLinks, entryData) {
	const fixedLinks = [];
	if (mode > 0) {
		const comparePaths = rawLinks.map(link => {
			if (!link.hasHttp) {
				const parsedUrl = URL.parse(link.rawUrl, "http://abc/" + entry.path);
				if (parsedUrl !== null) return parsedUrl.pathname.substring(1).toLowerCase();
			}
			return null;
		});
		for (const compareEntry of entryData.filter(filterEntry => filterEntry.source == entry.source)) {
			if (rawLinks.length == 0) break;
			const comparePath = compareEntry.path.toLowerCase();
			for (let l = 0; l < rawLinks.length; l++)
				if (comparePaths[l] !== null && comparePath == comparePaths[l]) {
					if (compareEntry.url) fixedLinks.push(compareEntry.url);
					rawLinks.splice(l, 1);
					comparePaths.splice(l, 1);
					l -= 1;
				}
		}
	}

	for (const link of mode == 2 ? rawLinks.filter(filterLink => filterLink.hasHttp) : rawLinks) {
		const parsedUrl = URL.parse(link.rawUrl, link.baseUrl);
		if (parsedUrl !== null) fixedLinks.push(parsedUrl.href);
	}

	return fixedLinks
		.map(link => ({ id: entry.id, url: link, sanitizedUrl: sanitizeUrl(link) }))
		.filter((link, index, self) =>
			link.sanitizedUrl != entry.sanitizedUrl &&
			index == self.findIndex(link2 => link.sanitizedUrl == link2.sanitizedUrl)
		);
}

// Identify the file type by contents, or by file extension if returned type is too basic
async function mimeType(filePath) {
	const decoder = new TextDecoder();
	const types = (await Promise.all([
		new Deno.Command("mimetype", { args: ["-bM", filePath], stdout: "piped" }).output(),
		new Deno.Command("mimetype", { args: ["-b",  filePath], stdout: "piped" }).output(),
	])).map(type => decoder.decode(type.stdout).trim());
	if (types[0] == "text/plain") {
		if (types[1] != "image/x-xbitmap") {
			const fileInfo = decoder.decode((await new Deno.Command("file", { args: ["-b", filePath], stdout: "piped" }).output()).stdout);
			if (fileInfo.startsWith("xbm image")) return "image/x-xbitmap";
		}
		return types[1];
	}
	else if (types[0] == "application/octet-stream" && !types[1].startsWith("text/"))
		return types[1];
	else
		return types[0];
}

// Merge array1 with array2 by overwriting array1's values with those of array2
function overwriteArray(array1, array2) { return array1.map((v, i) => array2[i] || v) }

/*----------------------------------+
 | General-Purpose Helper Functions |
 +----------------------------------*/

// Attempt to revert source-specific markup alterations
function genericizeMarkup(html, entry) {
	switch (entry.source) {
		case "sgi": {
			// Fix anomaly with HTML files in the Edu/ directory
			if (entry.path.startsWith("Edu/"))
				html = html.replaceAll(/(?<!")\.\.\//g, '/');
			break;
		}
		case "einblicke": {
			html = html.replace(
				// Remove footer
				/\n?<hr>\n?Original: .*? \[\[<a href=".*?">Net<\/a>\]\]\n?$/im,
				''
			).replaceAll(
				// Replace image link placeholders
				/(?!<img .*?src=)"(?:[./]+)?(?:teufel|grey)\.gif"(?: alt="\[defekt\]")?/gis,
				'"[unarchived-media]"'
			).replaceAll(
				// Replace non-link image placeholders and remove added link
				// TODO: figure out how to prevent massive slowdown when "s" flag is applied
				/<a href=".*?">(<img .*?src=)"(?:[./]+)?link\.gif" alt="\[image\]"(.*?>)<\/a>/gi,
				'$1"[unarchived-media]"$2'
			).replaceAll(
				// Remove broken page warning
				/^<html><body>\n?<img src=".*?noise\.gif">\n?<strong>Vorsicht: Diese Seite k&ouml;nnte defekt sein!<\/strong>\n?\n?<hr>\n?/gi,
				''
			).replaceAll(
				// Update placeholder for missing forms
				/<p>\n?<strong>Hier sollte eigentlich ein Dialog stattfinden!<\/strong>\n?\[\[<a href=".*?">Net<\/a>\]\]\n?<p>\n?/gi,
				'<p>[[ Unarchived form element ]]</p>'
			).replaceAll(
				// Move external links to original link element
				/(?<=<a (?:(?!<\/a>).)*?href=")(?:[./]+)?fehler.htm("(?:(?!<\/a>).)*?<\/a>) \[\[<a href="(.*?)">Net<\/a>\]\]/gis,
				'$2$1'
			).replaceAll(
				// Handle extreme edge cases where an error link doesn't have an accompanying external link
				/(?<=<a .*?href=")(?:[./]+)?fehler.htm(?=".*?>.*?<\/a>)/gis,
				'[unarchived-link]'
			);
			break;
		}
		case "riscdisc": {
			if (entry.path.startsWith("WWW_BBCNC_ORG_UK"))
				html = html.replaceAll(
					// In bbcnc.org.uk only, the brackets are inside the link elements
					/(?<=<a\s.*?>(?:\s+)?)\[(.*?)\](?=(?:\s+)?<\/a>)/gis,
					'$1'
				);
			else
				html = html.replaceAll(
					// Uncomment opening link tags
					/<(?:(?:-- ?)|!(?:-- ?)?)(a\s.*?)(?: ?--)?>/gis,
					'<$1>'
				).replaceAll(
					// Uncomment closing link tags
					/<!?-- ?\/(a)(?: ?--)?>/gi,
					'</$1>'
				).replaceAll(
					// Remove brackets surrounding link elements
					/\[+(<a\s.*?>.*?<\/a>)\]+/gis,
					'$1'
				);
			if (entry.path.startsWith("WWW_HOTWIRED_COM"))
				html = html.replaceAll(
					// Replace imagemap placeholder with unarchived link notice
					/"[./]+no_imagemap\.htm"/gi,
					'"[unarchived-link]"'
				);
			break;
		}
		case "pcpress": {
			// Remove downloader software header
			html = html.replace(/^<META name="download" content=".*?">\n/s, '');
			// Attempt to fix broken external links
			const links = getLinks(html, entry.url)
				.filter(link => link.hasHttp && URL.canParse(link.rawUrl))
				.toSorted((a, b) => a.lastIndex - b.lastIndex);
			for (const link of links) {
				const httpExp = /^http:(?=\/?[^/])/i;
				const badDomainExp = /(?<=http:\/\/)[^./]+(?=\/)/i;
				const badAnchorExp = /(?<=#[^/]+)\//i;
				const badExtensionExp = /(?<=\.(html?|cgi|gif))\//i;
				link.url = link.rawUrl;
				if (httpExp.test(link.url))
					try { link.url = new URL(link.url.replace(httpExp, ""), link.baseUrl).href; } catch {}
				if (badDomainExp.test(link.url))
					try {
						const subdomain = link.url.match(badDomainExp)[0];
						link.url = new URL(
							link.url.replace(/^http:\/\/.*?\//i, "/"),
							link.baseUrl.replace(/(?<=http:\/\/).*?(?=\.)/i, subdomain)
						).href;
					} catch {}
				try {
					link.url = new URL(link.url).href
						.replace(/(?<![a-z]+:)\/\//i, "/")
						.replace(/(?<=\.html?)\/$/i, "");
				} catch {}
				const hasBadAnchor = badAnchorExp.test(link.url);
				const hasBadExtension = badExtensionExp.test(link.url);
				if (hasBadAnchor || hasBadExtension) {
					const splitIndex = link.url.search(hasBadAnchor ? badAnchorExp : badExtensionExp);
					const before = link.url.substring(0, splitIndex);
					const after = link.url.substring(splitIndex + 1);
					link.url = new URL(after, before).href;
				}
			}
			// Inject fixed links into markup
			let offset = 0;
			for (const link of links.filter(filterLink => filterLink.url != filterLink.rawUrl)) {
				const start = link.lastIndex - link.fullMatch.length;
				const inject = `${link.attribute}"${link.url}"`;
				const end = link.lastIndex;
				html = html.substring(0, start + offset) + inject + html.substring(end + offset);
				offset += inject.length - link.fullMatch.length;
			}
			break;
		}
		case "chipfun": {
			// Remove base directory definition
			html = html.replace(/^<base href=".*?">\n/, '');
			break;
		}
		case "netcontrol96":
		case "netcontrol98": {
			// Remove injected script that exists on exactly one page
			if (entry.path == "archive-b/ba1/index.shtml")
				html = html
					.replace(/\n?<script [^>]*src="\/archived.js".*?>/, '')
					.replace(/ onLoad="shownew\('\/'\)"/, '');
			// Reverse encryption of email strings
			const decodeEmail = encodedEmail => {
				const bytes = encodedEmail.match(/.{1,2}/g).map(byte => parseInt(byte, 16));
				return bytes.slice(1).map(byte => String.fromCharCode(byte ^ bytes[0])).join("");
			}
			html = html.replaceAll(
				// Remove injected CloudFlare scripts
				/<script [^>]*src="[^"]+\/cloudflare-static\/.*?" data-cf-settings="[0-9a-f]{24}-\|49"(?: defer(?:="")?)?><\/script>/g,
				''
			).replaceAll(
				// Remove indicators of modified script elements
				/ type="[0-9a-f]{24}-text\/javascript"/g,
				''
			).replaceAll(
				// Revert altered mouse event attributes
				/if \(!window.__cfRLUnblockHandlers\) return false; /g,
				''
			).replaceAll(
				// Remove indicators of modified mouse event attributes
				/ data-cf-modified-[0-9a-f]{24}-=""/g,
				''
			).replaceAll(
				// Restore encrypted plaintext emails
				/<span class="__cf_email__" data-cfemail="([0-9a-f]+)">\[email&#160;protected\]<\/span>/g,
				(_, encodedEmail) => decodeEmail(encodedEmail)
			).replaceAll(
				// Restore encrypted mailto links
				/"\/cdn-cgi\/l\/email-protection#([0-9a-f]+)"/g,
				(_, encodedEmail) => "mailto:" + decodeEmail(encodedEmail)
			).replaceAll(
				// Remove injected ads
				/<script[^>]+> <!--var dd=document;.*?--><\/script>/gs,
				''
			).replaceAll(
				// Remove ad-related comments
				/<!-- (?:GOCLICK\.COM |END OF )POP-UNDER CODE(?: V1)? -->/g,
				''
			).replaceAll(
				// Remove header comment
				/^<!-- Netcontrol preface \/\/-->/gm,
				''
			).replaceAll(
				// Revert altered title tags
				/<title>NetControl.net Archive of :: ?(.*?)<\/(title)>/gis,
				'<$2>$1</$2>'
			).replaceAll(
				// Remove title tags that were replaced with file paths
				/<title>\\Stuff\\.*?<\/title>\n?/gi,
				''
			).replaceAll(
				// Remove metadata tag
				/(?:\n *)?<META NAME="GENERATOR" CONTENT="Mozilla\/.*?">/gim,
				''
			).replaceAll(
				// Remove indents before header elements
				/(<head>)(.*?)(<\/head>)/gis,
				(_, headOpen, headBody, headClose) => headOpen + headBody.replaceAll(/^ +/gm, '') + headClose
			).replaceAll(
				// Remove header message
				/(?:<body[^>]+>)?<p align="center">Archived Pages from 20th Century!!<center>\n?<br>(?:<!--#include virtual="[^"]+" -->)?\n?<BR>/gs,
				''
			).replaceAll(
				// Remove footer HTML (variation 1)
				/\n?<center><br><br><p align="center"><!-- Netcontrol footer \/\/-->/g,
				''
			).replaceAll(
				// Remove footer HTML (variation 2)
				/<br><center><br>(?:<!--#include virtual=".*?" -->)?<BR><img src="[^"]+\/okto-banner.gif" border=0><\/a>/g,
				''
			);
			// Fix images on pages with base URL
			if (baseExp.test(html))
				html = html.replaceAll(linkExp, (_, tagStart, url) => {
					if (/^(?:src|background)/i.test(tagStart))
						url = `"${trimQuotes(url.substring(url.lastIndexOf("/") + 1))}"`;
					return tagStart + url;
				});
			break;
		}
		case "amigaplus": {
			// Convert CD-ROM local links into path links
			html = html.replaceAll("file:///d:/Amiga_HTML/", "/");
			break;
		}
		case "netonacd": {
			// Move real URLs back to original attribute
			html = html.replaceAll(/"([^"]+)"?\s+tppabs="(.*?)"/g, '"$2"');
			break;
		}
	}
	return html;
}

// Attempt to fix invalid/deprecated/non-standard markup
function improvePresentation(html, compatMode = false) {
	if (!compatMode && !args["build"]) {
		const style = '<link rel="stylesheet" href="/presentation.css">';
		const matchHead = html.match(/<head(er)?(| .*?)>/i);
		html = matchHead !== null
			? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
			: style + "\n" + html;
	}

	html = html.replaceAll(
		// Fix closing title tags with missing slash
		/<(title)>((?:(?!<\/title>).)*?)<(title)>/gis,
		'<$1>$2</$3>'
	).replaceAll(
		// Fix attributes with missing end quote
		/([a-z]+ *= *"[^"]*?)(>[^"]*?"[^>]*")/gis,
		'$1"$2'
	).replaceAll(
		// Remove spaces from comment closing sequences
		/(<! *-+(?:(?!<! *-+).)*?-+) +>/gs,
		'$1>',
	).replaceAll(
		// Fix single-line comments with missing closing sequence
		/<!( *-+)([^<]+)(?<!-+ *)>/g,
		'<!$1$2-->'
	).replaceAll(
		// Fix multi-line comments with missing closing sequence
		/<!( *-+)([^<]+)(?<!-+ *)>(?!(?:(?!<! *-+).)*?-+>)/gs,
		'<!$1$2-->'
	).replaceAll(
		// Fix non-standard <marquee> syntax
		/<(marquee) +text *= *"(.*?)".*?>/gis,
		'<$1>$2</$1>'
	).replaceAll(
		// Add missing closing tags to link/table elements
		/(<(a|table)\s(?:(?!<\/\2>).)*?>(?:(?!<\/\2>).)*?)(?=$|<\2\s)/gis,
		'$1</$2>'
	).replaceAll(
		// Add missing closing tags to list elements
		/(<(dt|dd)>(?:(?!<\/\1>).)*?)(?=<(?:dl|dt|dd|\/dl))/gis,
		'$1</$2>'
	).replaceAll(
		// Add missing "s" to <noframe> elements
		/(<\/?)(no) ?(frame)(>)/gi,
		(_, start, no, frame, end) => start + no + frame + (frame == frame.toUpperCase() ? "S" : "s") + end
	);

	// Try to fix any remaining comments with missing closing sequences
	if (/<! *-/.test(html) && !/- *>/.test(html))
		html = html.replaceAll(/<!( *-.*$)/gm, '<!$1-->');

	if (!compatMode) {
		// Convert <plaintext> into <pre>
		const plaintextExp = /<plaintext>/gi;
		for (let match; (match = plaintextExp.exec(html)) !== null;) {
			const openIndex = match.index;
			const startIndex = plaintextExp.lastIndex;
			const endIndex = html.toLowerCase().indexOf("</plaintext>", startIndex);
			const closeIndex = endIndex != -1 ? endIndex + 12 : -1;

			const upperCase = match[0] == match[0].toUpperCase();
			const content = (upperCase ? "<PRE>" : "<pre>")
				+ html.substring(startIndex, endIndex != -1 ? endIndex : undefined).replaceAll("<", "&lt;").replaceAll(">", "&gt;")
				+ (upperCase ? "</PRE>" : "</pre>");

			html = html.substring(0, openIndex) + content + (closeIndex != -1 ? html.substring(closeIndex) : "");
		}

		// Restore <isindex> on modern browsers
		const isindexExp = /<isindex.*?>/gis;
		for (let match; (match = isindexExp.exec(html)) !== null;) {
			const isindex = match[0];
			const matchPrompt = [...isindex.matchAll(/prompt *= *(".*?"|[^ >]+)/gis)];
			const matchAction = [...isindex.matchAll(/action *= *(".*?"|[^ >]+)/gis)];

			let formStart = "";
			let formEnd = "";
			let prompt = "This is a searchable index. Enter search keywords: ";
			if (matchPrompt.length > 0 && matchPrompt[0].length > 0)
				prompt = trimQuotes(matchPrompt[0][1]);
			if (matchAction.length > 0 && matchAction[0].length > 0) {
				formStart = `<form action=${trimQuotes(matchAction[0][1])}>`;
				formEnd = "</form>";
			}

			html = html.substring(0, isindexExp.lastIndex - isindex.length)
				+ formStart + "<hr>" + prompt + "<input><hr>" + formEnd
				+ html.substring(isindexExp.lastIndex);
		}
	}

	return html;
}

// Find and return links in the given markup, without performing any operations
function getLinks(html, baseUrl) {
	if (baseExp.test(html)) baseUrl = trimQuotes(html.match(baseExp)[1]);

	const links = [];
	const addLink = (match, doQuotes = true) => {
		if (match === null) return;
		const rawUrl = trimQuotes(match[2]);
		const hasHttp = /^https?:/i.test(rawUrl);
		// Anchor, unarchived, and non-HTTP links should be ignored
		if (rawUrl.startsWith("#") || /^\[unarchived-(link|image)\]$/.test(rawUrl)
		|| (!hasHttp && /^[a-z]+:/i.test(rawUrl)))
			return;
		links.push({
			fullMatch: match[0],
			attribute: match[1],
			rawUrl: rawUrl,
			baseUrl: baseUrl || undefined,
			lastIndex: match.index + match[0].length,
			hasHttp: hasHttp,
			doQuotes: doQuotes,
		});
	};

	for (let match; (match = linkExp.exec(html)) !== null;) addLink(match);
	addLink(html.match(/(http-equiv *= *"?refresh"?[^>]+content *= *"(?:.*?URL=)?)(.*?)(?=")/i), false);

	return links;
}

// Retrieve text from file and convert to UTF-8 if necessary
async function getText(filePath, source) {
	if (!await validPath(filePath) || Deno.stat(filePath).size == 0) return "";
	let text;
	try {
		const decoder = new TextDecoder();
		switch (source) {
			case "wwwdir": {
				// World Wide Web Directory has some double-encoding weirdness that needs to be untangled
				const iconvOut = (
					await new Deno.Command("iconv", { args: [filePath, "-cf", "UTF-8", "-t", "WINDOWS-1252"], stdout: "piped" }).output()
				).stdout;

				const uchardetProcess = new Deno.Command("uchardet", { stdin: "piped", stdout: "piped" }).spawn();
				const uchardetWriter = uchardetProcess.stdin.getWriter();
				await uchardetWriter.write(iconvOut);
				await uchardetWriter.ready;
				await uchardetWriter.close();
				const uchardetStr = decoder.decode((await uchardetProcess.output()).stdout).trim();
				uchardetProcess.unref();

				const iconv2Process = new Deno.Command("iconv", { args: ["-cf", uchardetStr, "-t", "UTF-8"], stdin: "piped", stdout: "piped" }).spawn();
				const iconv2Writer = iconv2Process.stdin.getWriter();
				await iconv2Writer.write(iconvOut);
				await iconv2Writer.ready;
				await iconv2Writer.close();
				const iconv2Str = decoder.decode((await iconv2Process.output()).stdout);
				iconv2Process.unref();

				text = iconv2Str;
				break;
			}
			case "einblicke": {
				// Einblicke ins Internet is already UTF-8 and anything that isn't detected as such causes issues, so don't try to convert it
				text = await Deno.readTextFile(filePath);
				break;
			}
			default: {
				let uchardetStr = decoder.decode((await new Deno.Command("uchardet", { args: [filePath], stdout: "piped" }).output()).stdout).trim();
				// For some reason, files encoded in MAC-CENTRALEUROPE only convert correctly if interpreted as WINDOWS-1253
				if (uchardetStr == "MAC-CENTRALEUROPE") uchardetStr = "WINDOWS-1253";
				if (uchardetStr != "ASCII" && uchardetStr != "UTF-8")
					text = decoder.decode((
						await new Deno.Command("iconv", { args: [filePath, "-cf", uchardetStr, "-t", "UTF-8"], stdout: "piped" }).output()
					).stdout);
				else
					text = await Deno.readTextFile(filePath);
			}
		}
	}
	catch { text = await Deno.readTextFile(filePath); }
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// Strip the URL down to its bare components, for comparison purposes
function sanitizeUrl(url) {
	return safeDecode(url).toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/^([^/]+):80(?:80)?($|\/)/, "$1$2")
		.replace(/(?<=^[^#]+)#[^#]+$/, "")
		.replace(/index\.html?$/, "")
		.replace(/\/$/, "");
}

// Decode string without throwing an error if a single encoded character is invalid
function safeDecode(string) {
	const chars = string.split("");
	for (let c = 0; c < chars.length; c++) {
		if (chars[c] == "%" && c < chars.length - 2) {
			let decodedChar;
			try { decodedChar = decodeURIComponent(chars.join("").substring(c, c + 3)); }
			catch { continue; }
			chars.splice(c, 3, decodedChar);
		}
	}
	return chars.join("");
}

// Replace comments with whitespace
function blankComments(html) { return html.replaceAll(/<! *-+.*?-+ *>/gs, match => " ".repeat(match.length)); }

// Remove any quotes or whitespace surrounding a string
function trimQuotes(string) { return string.trim().replace(/^"?(.*?)"?$/s, "$1").replace(/[\r\n]+/g, "").trim(); }

// Return contents of template files
function getTemplate(file) { return Deno.readTextFileSync(`templates/${file}`); }

// Retrieve file data without consuming memory
async function getFileStream(path) { return (await fetch(new URL(path, import.meta.url))).body; }

// Log to the appropriate locations
function logMessage(message) {
	message = `[${new Date().toLocaleString()}] ${message}`;
	if (config.logFile) try { Deno.writeTextFile(config.logFile, message + "\n", { append: true }); } catch {}
	if (config.logToConsole) console.log(message);
}

// Check if a file or folder exists and is accessible
async function validPath(path) {
	try { await Deno.lstat(path); } catch { return false; }
	return true;
}