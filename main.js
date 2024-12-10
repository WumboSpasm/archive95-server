import { Database } from "jsr:@db/sqlite@0.12";
import { join as joinPath } from "jsr:@std/path";
import { parseArgs } from "jsr:@std/cli/parse-args";

const flags = parseArgs(Deno.args, {
	boolean: ["build", "wipe-cache"],
	string: ["config"],
	default: { "build": false, "wipe-cache": false, "config": "archive95.json" }
});

/*----------------------------+
 | Important Global Constants |
 +----------------------------*/

const defaultConfig = {
	port: 8989,
	https: {
		port: 8990,
		certificate: "",
		key: "",
	},
	accessHost: "",
	dataPath: "data",
	logFile: "archive95.log",
	logToConsole: true,
	doCaching: false,
	doCompatMode: true,
	resultsPerPage: 50,
	doInlinks: true,
};
const config = Object.assign({}, defaultConfig, JSON.parse(
	await validFile(flags["config"])
		? await Deno.readTextFile(flags["config"])
		: "{}"
));

const staticFiles = [
	["meta/images/logo.gif", "logo.gif", "image/gif"],
	["meta/images/dice.gif", "dice.gif", "image/gif"],
	["meta/images/compat/logo.gif", "compat/logo.gif", "image/gif"],
	["meta/images/compat/dice.gif", "compat/dice.gif", "image/gif"],
	["meta/images/compat/hide.gif", "compat/hide.gif", "image/gif"],
	["meta/images/compat/random.gif", "compat/random.gif", "image/gif"],
	["meta/images/compat/home.gif", "compat/home.gif", "image/gif"],
	["meta/images/compat/screenshot.gif", "compat/screenshot.gif", "image/gif"],
	["meta/css/search.css", "search.css", "text/css"],
	["meta/css/navbar.css", "navbar.css", "text/css"],
	["meta/css/presentation.css", "presentation.css", "text/css"],
];

const templates = {
	search: {
		main: await Deno.readTextFile("meta/templates/search.html"),
		about: await Deno.readTextFile("meta/templates/search_about.html"),
		source: await Deno.readTextFile("meta/templates/search_source.html"),
		result: await Deno.readTextFile("meta/templates/search_result.html"),
		navigate: await Deno.readTextFile("meta/templates/search_navigate.html"),
		compat: {
			main: await Deno.readTextFile("meta/templates/compat/search.html"),
			about: await Deno.readTextFile("meta/templates/compat/search_about.html"),
			source: await Deno.readTextFile("meta/templates/compat/search_source.html"),
			result: await Deno.readTextFile("meta/templates/compat/search_result.html"),
		},
	},
	navbar: {
		main: await Deno.readTextFile("meta/templates/navbar.html"),
		archive: await Deno.readTextFile("meta/templates/navbar_archive.html"),
		screenshot: await Deno.readTextFile("meta/templates/navbar_screenshot.html"),
		compat: {
			main: await Deno.readTextFile("meta/templates/compat/navbar.html"),
			screenshot: await Deno.readTextFile("meta/templates/compat/navbar_screenshot.html"),
		},
	},
	embed: {
		text: await Deno.readTextFile("meta/templates/embed_text.html"),
		audio: await Deno.readTextFile("meta/templates/embed_audio.html"),
		other: await Deno.readTextFile("meta/templates/embed_other.html"),
	},
	inlinks: {
		main: await Deno.readTextFile("meta/templates/inlinks.html"),
		link: await Deno.readTextFile("meta/templates/inlinks_link.html"),
		error: await Deno.readTextFile("meta/templates/inlinks_error.html"),
	},
	error: {
		archive: await Deno.readTextFile("meta/templates/error_archive.html"),
		generic: await Deno.readTextFile("meta/templates/error_generic.html"),
		server: await Deno.readTextFile("meta/templates/error_server.html"),
	},
};

const possibleModes = ["view", "orphan", "raw", "inlinks", "random"];
const possibleFlags = ["e", "m", "n", "o", "p"];

const databasePath = joinPath(config.dataPath, "archive95.sqlite");

/*----------------+
 | Build Database |
 +----------------*/

if (flags["build"]) {
	const startTime = Date.now();

	const cachePath = joinPath(config.dataPath, "cache");
	if (flags["wipe-cache"]) {
		logMessage("wiping cache...");
		await Deno.remove(cachePath, { recursive: true });
	}

	logMessage("creating new database...");
	if (await validFile(databasePath)) await Deno.remove(databasePath);
	if (await validFile(databasePath + "-shm")) await Deno.remove(databasePath + "-shm");
	if (await validFile(databasePath + "-wal")) await Deno.remove(databasePath + "-wal");
	const db = new Database(databasePath, { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA shrink_memory");

	/* Sources */

	logMessage("creating sources table...");
	db.prepare(`CREATE TABLE sources (
		id INTEGER PRIMARY KEY,
		short TEXT NOT NULL,
		title TEXT NOT NULL,
		author TEXT NOT NULL,
		link TEXT NOT NULL,
		year INTEGER NOT NULL,
		month INTEGER NOT NULL,
		mode INTEGER NOT NULL
	)`).run();

	const sourceData = (await Deno.readTextFile(joinPath(config.dataPath, "sources.txt"))).split(/[\r\n]+/g).map((source, s, data) => {
		source = overwriteArray([data.length, ...Array(5).fill("undefined"), 0], source.split("\t"));
		logMessage(`[${s + 1}/${data.length}] loading source ${source[1]}...`);
		return {
			id: s,
			short: source[0],
			title: source[1],
			author: source[2],
			year: source[3],
			month: source[4],
			link: source[5],
			// 0 = all links point to original locations
			// 1 = relative paths point to local filesystem, but keep non-existent paths intact
			// 2 = relative paths point to local filesystem, and mark non-existent paths as unarchived
			mode: parseInt(source[6]) || 0,
		};
	});

	logMessage("adding sources to database...");
	const sourceQuery = db.prepare("INSERT INTO sources (id, short, title, author, link, year, month, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	for (let s = 0; s < sourceData.length; s++) {
		const source = sourceData[s];
		logMessage(`[${s + 1}/${sourceData.length}] adding source ${source.short}...`);
		sourceQuery.run(source.id, source.short, source.title, source.author, source.link, source.year, source.month, source.mode);
	}

	/* Entries, Text Content, Inlinks */

	logMessage("creating files table...");
	db.prepare(`CREATE TABLE files (
		id INTEGER PRIMARY KEY,
		path TEXT NOT NULL,
		url TEXT NOT NULL,
		sanitizedUrl TEXT NOT NULL,
		source TEXT NOT NULL,
		type TEXT NOT NULL,
		warn INTEGER NOT NULL,
		skip INTEGER NOT NULL
	)`).run();

	logMessage("creating text table...");
	db.prepare(`CREATE TABLE text (
		id INTEGER PRIMARY KEY,
		title TEXT NOT NULL,
		content TEXT NOT NULL
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
		const typesPath = joinPath(cachePath, "types.txt");
		const typesList = await validFile(typesPath)
			? (await Deno.readTextFile(typesPath)).split(/[\r\n]+/g).map(typeLine => typeLine.split("\t"))
			: [];

		// Load in entry data
		const entries = [];
		let currentEntry = 0;
		for (const source of sourceData) {
			for (const entryLine of (await Deno.readTextFile(joinPath(config.dataPath, `sources/${source.short}.txt`))).split(/[\r\n]+/g)) {
				const [path, url, warn, skip] = overwriteArray(["undefined", "", "false", "false"], entryLine.split("\t"));
				const filePath = joinPath(config.dataPath, `sources/${source.short}/${path}`);
				logMessage(`[${++currentEntry}/??] loading file ${filePath}...`);
				const entry = {
					path: path,
					url: url,
					sanitizedUrl: sanitizeUrl(url),
					source: source.short,
					type: "",
					warn: warn.toLowerCase() == "true",
					skip: skip.toLowerCase() == "true",
					title: "",
					content: "",
					links: [],
				};
				if (!entry.skip) {
					const typeLine = typesList.find(typeLine => typeLine[0] == filePath);
					if (typeLine != undefined)
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
							entry.content = text.replaceAll(/[\n\t ]+/g, " ").trim();
					}
				}
				entries.push(entry);
			}
		}

		// Write type cache
		Deno.writeTextFile(joinPath(cachePath, "types.txt"), typesList.map(typeLine => typeLine.join("\t")).join("\n"));

		// Sort entries and give them IDs based on the new order
		logMessage("sorting files...");
		entries.sort((a, b) => {
			if (a.title == "") return 1;
			if (b.title == "") return -1;
			return a.title.localeCompare(b.title, "en", { sensitivity: "base" });
		});
		entries.sort((a, b) => {
			if (a.title != "" || b.title != "") return 0;
			return a.sanitizedUrl.localeCompare(b.sanitizedUrl, "en", { sensitivity: "base" });
		});
		entries.forEach((entry, e) => Object.assign(entry, { id: e }));

		return entries;
	})();

	logMessage("adding files to database...");
	const fileQuery = db.prepare("INSERT INTO files (id, path, url, sanitizedUrl, source, type, warn, skip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
	const textQuery = db.prepare("INSERT INTO text (id, title, content) VALUES (?, ?, ?)");
	const linkQuery = db.prepare("INSERT INTO links (id, url, sanitizedUrl) VALUES (?, ?, ?)");
	for (let e = 0; e < entryData.length; e++) {
		const entry = entryData[e];
		logMessage(`[${e + 1}/${entryData.length}] adding file sources/${entry.source}/${entry.path}...`);
		fileQuery.run(entry.id, entry.path, safeDecode(entry.url), entry.sanitizedUrl, entry.source, entry.type, entry.warn, entry.skip);
		if (entry.title != "" || entry.content != "")
			textQuery.run(entry.id, entry.title, entry.content);
		if (config.doInlinks) {
			const parsedLinks = resolveLinks(
				entry, sourceData.find(source => source.short == entry.source).mode,
				entry.links, entryData
			);
			for (const link of parsedLinks)
				linkQuery.run(link.id, safeDecode(link.url), link.sanitizedUrl);
		}
	}

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

const sourceInfo = db.prepare("SELECT * FROM sources").all();

const serverHandler = async (request, info) => {
	logMessage(info.remoteAddr.hostname + ": " + request.url);

	const requestUrl = URL.parse(request.url);
	if (requestUrl == null) throw new Error();

	// Render search page and navbar in basic markup if user agent is not considered modern
	const compatMode = config.doCompatMode && !isModern(request.headers.get("User-Agent") || "");

	// If access host is configured, do not allow connections through any other hostname
	// (requests with missing Host header are exempt from this, to satisfy some ancient browsers)
	if (config.accessHost != "" && requestUrl.hostname != config.accessHost && (!config.doCompatMode || request.headers.has("Host")))
		throw new Error();

	// Serve homepage/search results
	const requestPath = requestUrl.pathname.replace(/^[/]+/, "");
	if (requestPath == "")
		return new Response(prepareSearch(requestUrl.searchParams, compatMode), { headers: { "Content-Type": "text/html;charset=utf-8" } });

	// Serve static files
	for (const exception of staticFiles.concat(sourceInfo.map(source => ["meta/images/" + source.short + ".gif", source.short + ".gif", "image/gif"])))
		if (requestPath == exception[1])
			return new Response(await Deno.readFile(exception[0]), { headers: { "Content-Type": exception[2] } });

	// Serve page screenshots
	if (["screenshots/", "thumbnails/"].some(dir => requestPath.startsWith(dir))) {
		const screenshot = db.prepare("SELECT path FROM screenshots WHERE path = ?").get(requestPath.substring(requestPath.indexOf("/") + 1));
		if (screenshot != null) {
			if (requestPath.startsWith("screenshots/"))
				return new Response(await Deno.readFile(joinPath(config.dataPath, "screenshots", screenshot.path)), { headers: { "Content-Type": "image/gif" } });
			else {
				const thumbnail = (await new Deno.Command("convert",
					{ args: [joinPath(config.dataPath, "screenshots", screenshot.path), "-geometry", "x64", "-"], stdout: "piped" }
				).output()).stdout;
				return new Response(thumbnail, { headers: { "Content-Type": "image/gif" } });
			}
		}
	}

	const slashIndex = requestPath.indexOf("/");
	let url, args;
	if (slashIndex != -1) {
		const search = (requestUrl.search == "" && request.url.endsWith("?")) ? "?" : requestUrl.search;
		url = safeDecode(requestPath.substring(slashIndex + 1) + search);
		args = splitArgs(requestPath.substring(0, slashIndex));
	}
	else {
		url = "";
		args = splitArgs(requestPath);
	}
	if (args == null) return error();

	if (args.mode == "random") {
		const entry = getRandom(args.flags, args.source);
		return Response.redirect(requestUrl.origin + (
			entry.url != ""
				? `/${joinArgs("view", entry.source, args.flags)}/${entry.url}`
				: `/${joinArgs("orphan", entry.source, args.flags)}/${entry.path}`
		));
	}

	if (url == "") return error();

	if (args.mode == "inlinks") {
		if (url == "" || !config.doInlinks) return error();
		const sanitizedUrl = sanitizeUrl(url);
		const inlinkQuery = db.prepare(
			"SELECT path, files.url, files.sanitizedUrl, source FROM files LEFT JOIN links ON files.id = links.id WHERE links.sanitizedUrl = ?"
		).all(sanitizedUrl);

		let inlinks;
		if (inlinkQuery.length > 0) {
			const links = inlinkQuery.map(inlink => {
				let linkBullet = templates.inlinks.link;

				if (inlink.url != "")
					linkBullet = linkBullet
						.replace("{LINK}", !args.flags.includes("e")
							? `/${joinArgs("view", inlink.source, args.flags)}/${inlink.url}`
							: inlink.url)
						.replace("{ORIGINAL}", inlink.url);
				else
					linkBullet = linkBullet
						.replace("{LINK}", !args.flags.includes("e")
							? `/${joinArgs("orphan", inlink.source, args.flags.replace("n", ""))}/${inlink.path}`
							: `/${inlink.path}`)
						.replace("{ORIGINAL}", inlink.path);

				return linkBullet.replace("{SOURCE}", inlink.source);
			});
			inlinks = templates.inlinks.main
				.replaceAll("{URL}", sanitizedUrl)
				.replace("{LINKS}", links.join("\n"));
		}
		else
			inlinks = templates.inlinks.error
				.replaceAll("{URL}", sanitizedUrl);

		return new Response(inlinks, { headers: { "Content-Type": "text/html" } });
	}

	let archives = [];
	let desiredArchive = 0;
	if (args.mode == "view") {
		const sanitizedUrl = sanitizeUrl(url);
		archives = db.prepare("SELECT * FROM files WHERE sanitizedUrl = ? AND skip = 0").all(sanitizedUrl);
		if (archives.length == 0) return error(url);
		if (archives.length > 1) {
			// Sort archives from oldest to newest
			archives.sort((a, b) => {
				const asort = sourceInfo.find(source => source.short == a.source).id;
				const bsort = sourceInfo.find(source => source.short == b.source).id;
				return asort - bsort;
			});
			// Get desired archive by first looking for exact URL match, then sanitized URL if there are no exact matches
			if (args.source != "") {
				desiredArchive = archives.findIndex(archive =>
					archive.source == args.source && archive.url == url
				);
				if (desiredArchive == -1)
					desiredArchive = archives.findIndex(archive =>
						archive.source == args.source && sanitizeUrl(archive.url) == sanitizedUrl
					);
				desiredArchive = Math.max(0, desiredArchive);
			}
		}
	}
	else if (args.mode == "orphan" || args.mode == "raw") {
		if (args.source == "" || url == "") return error();
		const entry = db.prepare("SELECT * FROM files WHERE source = ? AND path = ? AND skip = 0").get(args.source, url);
		if (entry == null) return error();
		archives.push(entry);
	}
	// Encode number sign to make sure it's properly identified as part of the URL
	for (const archive of archives)
		archive.url = archive.url.replaceAll("#", "%23");

	const entry = archives[desiredArchive];
	const filePath = joinPath(config.dataPath, "sources", entry.source, entry.path);
	let file;
	let contentType = entry.type;

	// If the requested entry is an HTML page, serve from cache if possible
	if (contentType == "text/html") {
		const cachedHtml = await getCachedPage(entry.id, args, compatMode);
		if (cachedHtml != null) return new Response(cachedHtml, { headers: { "Content-Type": "text/html;charset=utf-8" } });
	}

	if (args.mode != "raw" && !args.flags.includes("p")) {
		if (contentType == "image/x-xbitmap") {
			// Convert XBM to GIF
			file = (await new Deno.Command("convert", { args: [filePath, "GIF:-"], stdout: "piped" }).output()).stdout;
			contentType = "image/gif";
		}
		else if (entry.source == "riscdisc" && contentType == "image/gif")
			// Fix problematic GIFs present in The Risc Disc Volume 2
			file = (await new Deno.Command("convert", { args: [filePath, "+repage", "-"], stdout: "piped" }).output()).stdout;
	}

	if (!compatMode && args.mode == "view" && !args.flags.includes("n") && contentType != "text/html") {
		// Embed non-HTML files when navbar is enabled
		let embed;
		if (contentType.startsWith("text/"))
			embed = templates.embed.text
				.replace("{URL}", entry.sanitizedUrl)
				.replace("{TEXT}", await getText(filePath, entry.source));
		else
			embed = (contentType.startsWith("audio/") ? templates.embed.audio : templates.embed.other)
				.replace("{URL}", entry.sanitizedUrl)
				.replace("{TYPE}", contentType)
				.replace("{FILE}", `/${joinArgs("view", entry.source, args.flags + "n")}/${entry.url}`);
		embed = injectNavbar(embed, archives, desiredArchive, args.flags);
		await cachePage(entry.id, args, false, embed);
		return new Response(embed, { headers: { "Content-Type": "text/html;charset=utf-8" } });
	}
	else if (args.mode == "raw" || contentType != "text/html")
		// Serve actual file data if raw or non-HTML
		return new Response(file || await Deno.readFile(filePath), { headers: { "Content-Type": contentType } });

	// Make adjustments to page markup before serving
	let html = await getText(filePath, entry.source);
	html = genericizeMarkup(html, entry);
	html = redirectLinks(html, entry, args.flags, getLinks(html, entry.url));
	if (!args.flags.includes("p"))
		html = improvePresentation(html, compatMode);
	if (args.mode == "view" && !args.flags.includes("n"))
		html = injectNavbar(html, archives, desiredArchive, args.flags, compatMode);

	// Cache and serve the page
	await cachePage(entry.id, args, compatMode, html);
	return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
};
const serverError = (error) => {
	let errorHtml = templates.error.server;
	let status;
	if (error.message == "") {
		errorHtml = errorHtml.replace("{MESSAGE}", "Connections through this host are not allowed.");
		status = 400;
	}
	else {
		logMessage(error);
		errorHtml = errorHtml.replace("{MESSAGE}", "The server had trouble processing your request.");
		status = 500;
	}
	return new Response(errorHtml, { status: status, headers: { "Content-Type": "text/html" } });
};

// Start server on HTTP, and if configured to do so, HTTPS
Deno.serve({
	port: config.port,
	hostname: config.hostName,
	onError: serverError,
}, serverHandler);
if (config.https.certificate && config.https.key)
	try {
		Deno.serve({
			port: config.https.port,
			cert: Deno.readTextFileSync(config.https.certificate),
			key: Deno.readTextFileSync(config.https.key),
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
function prepareSearch(params, compatMode = false) {
	const search = {
		inUrl: !params.has("in") || params.has("in", "url"),
		inTitle: !params.has("in") || params.has("in", "title"),
		inContent: !params.has("in") || params.has("in", "content"),
		formatsAll: !params.has("formats") || params.get("formats") == "all",
		formatsText: params.get("formats") == "text",
		formatsMedia: params.get("formats") == "media",
	};

	let html = (!compatMode ? templates.search.main : templates.search.compat.main)
		.replace("{QUERY}", sanitizeInject((params.get("query") || "").replaceAll("&", "&amp;")))
		.replace("{INURL}", search.inUrl ? " checked" : "")
		.replace("{INTITLE}", search.inTitle ? " checked" : "")
		.replace("{INCONTENT}", search.inContent ? " checked" : "")
		.replace("{FORMATSALL}", search.formatsAll ? " checked" : "")
		.replace("{FORMATSTEXT}", search.formatsText ? " checked" : "")
		.replace("{FORMATSMEDIA}", search.formatsMedia ? " checked" : "");

	if (params.has("query")) {
		let whereConditions = [];
		if (search.inUrl)
			whereConditions.push("url LIKE ?1");
		if (search.inTitle)
			whereConditions.push("title LIKE ?1");
		if (search.inContent)
			whereConditions.push("content LIKE ?1");

		let searchString = safeDecode(params.get("query"));
		searchString = searchString.toLowerCase();

		// Escape any wildcard characters that exist in the search query
		if (/[%_^]/g.test(searchString))
			whereConditions = whereConditions.map(condition => `(${condition} ESCAPE "^")`);

		let whereString = whereConditions.join(" OR ");
		if (search.formatsText)
			whereString += " AND type LIKE 'text/%'";
		else if (search.formatsMedia)
			whereString += " AND type NOT LIKE 'text/%'";

		const lastId = parseInt(params.get("last"));
		const firstId = !lastId ? parseInt(params.get("first")) : NaN;
		const compareId = lastId || firstId || 0;

		const resultsPerPage = Math.max(5, config.resultsPerPage);
		const searchQuery = searchString.length < 3 ? [] : db.prepare(`
			SELECT files.id, url, source, text.title, text.content
			FROM files LEFT JOIN text ON files.id = text.id
			WHERE files.id ${lastId ? "<=" : ">="} ?2 AND skip = 0 AND (${whereString})
			ORDER BY files.id ${lastId ? "DESC" : "ASC"} LIMIT ${resultsPerPage + 2}
		`).all(`%${searchString.replaceAll(/([%_^])/g, '^$1')}%`, compareId);
		if (lastId) searchQuery.reverse();

		// Pages are anchored around an entry ID, either preceding or succeeding it
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
			let titleInject = sanitizeInject(result.title || "");
			let titleMatchIndex = -1;
			if (titleInject != "") {
				if (search.inTitle && (titleMatchIndex = titleInject.toLowerCase().indexOf(searchString)) != -1)
					titleInject =
						titleInject.substring(0, titleMatchIndex) +
						"<b>" + titleInject.substring(titleMatchIndex, titleMatchIndex + searchString.length) + "</b>" +
						titleInject.substring(titleMatchIndex + searchString.length);
			}
			else
				titleInject = result.url;

			let urlInject = sanitizeInject(result.url || "");
			let urlMatchIndex = -1;
			if (search.inUrl && (urlMatchIndex = urlInject.toLowerCase().indexOf(searchString)) != -1)
				urlInject =
					urlInject.substring(0, urlMatchIndex) +
					"<b>" + urlInject.substring(urlMatchIndex, urlMatchIndex + searchString.length) + "</b>" +
					urlInject.substring(urlMatchIndex + searchString.length);

			let contentInject = result.content || "";
			let contentMatchIndex = -1;
			if (search.inContent && (contentMatchIndex = contentInject.toLowerCase().indexOf(searchString)) != -1) {
				const minBound = contentMatchIndex - 30;
				const maxBound = minBound + 200;
				contentInject = sanitizeInject(
					contentInject.substring(minBound, contentMatchIndex) +
					"<b>" + contentInject.substring(contentMatchIndex, contentMatchIndex + searchString.length) + "</b>" +
					contentInject.substring(contentMatchIndex + searchString.length, maxBound)
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

			resultSegments.push(
				(!compatMode ? templates.search.result : templates.search.compat.result)
					.replace("{ARCHIVE}", `/view-${result.source}/${result.url.replaceAll("#", "%23")}`)
					.replace("{TITLE}", titleInject)
					.replace("{URL}", urlInject)
					.replace("{SOURCE}", result.source)
					.replace("{TEXT}", contentInject)
			);
			if (compatMode) resultSegments.push("\t\t<hr>");
		}

		params.delete("first");
		params.delete("last");

		const totalResults = (prevId != -1 || nextId != -1) ? (resultsPerPage + "+") : searchQuery.length;
		const queryInject = sanitizeInject(params.get("query")).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
		if (!compatMode) {
			const prevText = "&lt;&lt; Prev";
			const nextText = "Next &gt;&gt;";
			const navigate = templates.search.navigate
				.replace("{TOTAL}", totalResults)
				.replace("{S}", searchQuery.length > 1 ? "s" : "")
				.replace("{QUERY}", queryInject)
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
					const prevButton = prevId == -1 ? "Prev" : `<a href="?${params.toString()}&last=${prevId}">Prev</a>`;
					const nextButton = nextId == -1 ? "Next" : `<a href="?${params.toString()}&first=${nextId}">Next</a>`;
					const navigate = `\t\t${prevButton} ${nextButton}`;
					resultSegments.unshift(navigate);
					if (nextId != -1)
						resultSegments.push(navigate);
				}
			}

			resultSegments.unshift(`\t\t<h2>${totalResults} results for "${queryInject}"</h2>`);
			html = html.replace("{CONTENT}", resultSegments.join("\n"));
		}
	}
	else {
		const sourceQuery = db.prepare(`
			SELECT sources.*, COUNT() AS size FROM files
			LEFT JOIN sources ON sources.short = files.source
			WHERE url != '' AND skip = 0 GROUP BY source ORDER BY sources.id
		`).all();
		const sources = [];
		for (const source of sourceQuery)
			sources.push(
				(!compatMode ? templates.search.source : templates.search.compat.source)
					.replace("{LINK}", source.link)
					.replace("{TITLE}", source.title)
					.replace("{AUTHOR}", source.author)
					.replace("{DATE}", `${source.month}`.padStart(2, "0") + "/" + source.year)
					.replace("{COUNT}", source.size.toLocaleString())
			);

		let about = (!compatMode ? templates.search.about : templates.search.compat.about)
			.replace("{SOURCES}", sources.join("\n"))
			.replace("{TOTAL}", sourceQuery.reduce((total, source) => total + source.size, 0).toLocaleString());

		if (compatMode) {
			const randomEntry = getRandom();
			about = about.replace("{RANDOM}", `/view-${randomEntry.source}/${randomEntry.url}`);
			html = html.replace("{CONTENT}", about);
		}
		else
			html = html
				.replace("{HEADER}", "About this website")
				.replace("{CONTENT}", about);
	}

	return html;
}

// Point links to archives, or the original URLs if "e" flag is enabled
function redirectLinks(html, entry, flags, rawLinks) {
	const rootSource = sourceInfo.find(source => source.short == entry.source);
	const orphanFlags = flags.replace("n", "");
	const noNavFlags = orphanFlags + "n";

	const unmatchedLinks = rawLinks.map(link => {
		const matchStart = link.lastIndex - link.fullMatch.length;
		const matchEnd = link.lastIndex;
		const parsedUrl = URL.parse(link.rawUrl, link.baseUrl);
		if (parsedUrl != null)
			return {...link,
				url: parsedUrl.href,
				sanitizedUrl: sanitizeUrl(parsedUrl.href),
				start: matchStart,
				end: matchEnd,
				isEmbedded: !/^href/i.test(link.attribute),
			};
		else
			return null;
	}).filter(link => link != null);
	if (unmatchedLinks.length == 0) return html;

	const matchedLinks = [];

	// Filtering function to remove duplicate entries by their distance from the root source date
	const nearestEntryOnly = (entry, _, self) => {
		const source  = sourceInfo.find(source => source.short == entry.source);
		const monthDist  = Math.abs((rootSource.year * 12 + rootSource.month) - (source.year * 12 + source.month));
		for (const entry2 of self)
			if (entry.sanitizedUrl == entry2.sanitizedUrl && entry.source != entry2.source) {
				const source2 = sourceInfo.find(source => source.short == entry2.source);
				const monthDist2 = Math.abs((rootSource.year * 12 + rootSource.month) - (source2.year * 12 + source2.month));
				return monthDist < monthDist2;
			}
		return true;
	};

	// Check for path matches (needed for sources that have their own filesystems)
	if (rootSource.mode > 0) {
		const comparePaths = [];
		const comparePathsQuery = [];
		for (const link of unmatchedLinks) {
			if (!link.isWhole) {
				const parsedUrl = URL.parse(link.rawUrl, "http://abc/" + entry.path);
				if (parsedUrl != null) {
					const comparePath = parsedUrl.pathname.substring(1).toLowerCase();
					comparePaths.push(comparePath + parsedUrl.hash);
					if (!comparePathsQuery.includes(comparePath + parsedUrl.hash)) {
						comparePathsQuery.push(comparePath + parsedUrl.hash);
						// Make sure database query takes into account anchored and anchorless variations of path
						if (parsedUrl.hash != "" && !comparePathsQuery.includes(comparePath))
							comparePathsQuery.push(comparePath);
					}
					continue;
				}
			}
			comparePaths.push(null);
		}

		if (comparePaths.length > 0) {
			const entryQuery = db.prepare(`SELECT path, url, source, skip FROM files WHERE source = ? AND path COLLATE NOCASE IN (${
				Array(comparePathsQuery.length).fill("?").join(", ")
			})`).all(entry.source, ...comparePathsQuery).filter(nearestEntryOnly);

			for (const compareEntry of entryQuery) {
				const entryComparePath = compareEntry.path.toLowerCase();
				for (let l = 0; l < unmatchedLinks.length; l++) {
					if (comparePaths[l] == null) continue;
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
							unmatchedLinks[l].isWhole = true;
							continue;
						}
						const entryUrl = compareEntry.url + pathAnchor;
						if (flags.includes("e"))
							unmatchedLinks[l].url = entryUrl != "" ? entryUrl : `/${compareEntry.path}`;
						else if (entryUrl != "")
							unmatchedLinks[l].url = `/${
								joinArgs("view", entry.source, unmatchedLinks[l].isEmbedded ? noNavFlags : flags)
							}/${entryUrl}`;
						else
							unmatchedLinks[l].url = `/${joinArgs("orphan", entry.source, orphanFlags)}/${compareEntry.path}`;
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
		const entryQuery = db.prepare(`SELECT path, sanitizedUrl, source FROM files WHERE sanitizedUrl IN (${
			Array(compareUrls.length).fill("?").join(", ")
		}) AND skip = 0`).all(...compareUrls).filter(nearestEntryOnly);

		if (entryQuery.length > 0) {
			// Check for source-local matches first
			const sourceLocalEntries = entryQuery.filter(filterEntry => filterEntry.source == entry.source);
			for (const sourceLocalEntry of sourceLocalEntries)
				for (let l = 0; l < unmatchedLinks.length; l++)
					if (sourceLocalEntry.sanitizedUrl == unmatchedLinks[l].sanitizedUrl) {
						unmatchedLinks[l].url = `/${
							joinArgs("view", entry.source, unmatchedLinks[l].isEmbedded ? noNavFlags : flags)
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
								joinArgs("view", sourceExternalEntry.source, unmatchedLinks[l].isEmbedded ? noNavFlags : flags)
							}/${unmatchedLinks[l].url}`;
							matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
							l -= 1;
						}
			}
		}

		// Point all clickable links to the Wayback Machine, and everything else to an invalid URL
		// We shouldn't be loading any content off of Wayback
		for (let l = 0; l < unmatchedLinks.length; l++) {
			if (rootSource.mode == 2 && !unmatchedLinks[l].isWhole)
				unmatchedLinks[l].url = unmatchedLinks[l].isEmbedded
					? "[unarchived-media]"
					: "[unarchived-link]";
			else
				unmatchedLinks[l].url = unmatchedLinks[l].isEmbedded
					? `/${joinArgs("view", entry.source, noNavFlags)}/${unmatchedLinks[l].url}`
					: getWaybackLink(unmatchedLinks[l].url, rootSource.year, rootSource.month);
		}
	}

	// Update markup with new links
	let offset = 0;
	let newHtml = "";
	for (const link of unmatchedLinks.concat(matchedLinks).toSorted((a, b) => a.start - b.start)) {
		newHtml += html.substring(0, link.start - offset) + `${link.attribute}"${link.url}"`;
		html = html.substring(link.end - offset);
		offset = link.end;
	}
	newHtml += html;

	// Remove base element if it exists
	return newHtml.replaceAll(/<base .*?>(?:.*?<\/base>)?\n?/gis, '');
}

// Display navigation bar
function injectNavbar(html, archives, desiredArchive, flags, compatMode = false) {
	const entry = archives[desiredArchive];
	const realUrl = entry.url.replaceAll("%23", "#");

	if (!compatMode) {
		const rootSource = sourceInfo.find(source => source.short == entry.source);
		let navbar = templates.navbar.main
			.replaceAll("{URL}", realUrl)
			.replace("{SHOWWARNING}", entry.warn ? "" : " hidden")
			.replace("{WAYBACK}", getWaybackLink(realUrl, rootSource.year, rootSource.month))
			.replace("{INLINKS}", `/${joinArgs("inlinks", null, flags)}/${entry.url}`)
			.replace("{SHOWINLINKS}", config.doInlinks ? "" : " hidden")
			.replace("{RAW}", `/${joinArgs("raw", entry.source)}/${entry.path}`)
			.replace("{HIDE}", `/${joinArgs("view", entry.source, flags + "n")}/${entry.url}`)
			.replace("{RANDOM}", `/${joinArgs("random", null, flags)}/`);

		const archiveButtons = [];
		for (let a = 0; a < archives.length; a++) {
			const archive = archives[a];
			const source = sourceInfo.find(source => source.short == archive.source);
			archiveButtons.push(
				templates.navbar.archive
					.replace("{ACTIVE}", a == desiredArchive ? ' class="navbar-active"' : "")
					.replace("{URL}", `/${joinArgs("view", source.short, flags)}/${archive.url}`)
					.replace("{ICON}", `/${source.short}.gif`)
					.replace("{TITLE}", source.title)
					.replace("{DATE}", `${source.month}`.padStart(2, "0") + "/" + source.year)
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
		html = matchHead != null
			? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
			: style + "\n" + html;

		const padding = '<div style="height:120px"></div>';
		const bodyCloseIndex = blankComments(html).search(/(?:(?:<\/(?:body|noframes|html)>[ \n\t]*)+)?$/i);
		html = bodyCloseIndex != -1
			? (html.substring(0, bodyCloseIndex) + padding + "\n" + navbar + "\n" + html.substring(bodyCloseIndex))
			: html + "\n" + padding + "\n" + navbar;

		return html;
	}
	else {
		const source = sourceInfo.find(source => source.short == entry.source);
		const randomEntry = getRandom(flags);
		let navbar = templates.navbar.compat.main
			.replace("{URL}", realUrl)
			.replace("{SOURCE}", source.title)
			.replace("{DATE}", `${source.month}`.padStart(2, "0") + "/" + source.year)
			.replace("{HIDE}", `/${joinArgs("view", entry.source, flags + "n")}/${entry.url}`)
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

		if (!/<frameset.*?>/i.test(html)) {
			const bodyOpenIndex = (blankComments(html).match(
				/^(?:[ \n\t]*(?:<(?:!DOCTYPE.*?|html|head(?:er)?.*?>.*?<\/head|body)>[ \n\t]*)+)?/is
			) || [""])[0].length;
			html = html.substring(0, bodyOpenIndex) + navbar + "\n" + html.substring(bodyOpenIndex);
		}

		return html;
	}
}

// Return a random entry
function getRandom(flags = "", source = "") {
	const whereConditions = ["skip = 0"];
	const whereParameters = [];
	if (!flags.includes("m"))
		whereConditions.push("type = 'text/html'");
	if (!flags.includes("o"))
		whereConditions.push("sanitizedUrl != ''");
	if (source != "") {
		whereConditions.push("source = ?");
		whereParameters.push(source);
	}
	return db.prepare(
		`SELECT path, url, source FROM files WHERE ${whereConditions.join(" AND ")} ORDER BY random() LIMIT 1`
	).get(...whereParameters);
}

// Split string of arguments into an object
function splitArgs(argsStr) {
	const args = {
		mode: "",
		source: "",
		flags: "",
	};

	const argsA = argsStr.split("_");
	const argsB = argsA[0].split("-");
	if (possibleModes.some(mode => mode == argsB[0]))
		args.mode = argsB[0];
	else
		return null;
	if (argsB.length > 1 && sourceInfo.some(source => source.short == argsB[1]))
		args.source = argsB[1];
	if (argsA.length > 1)
		for (const flag of possibleFlags)
			if (argsA[1].includes(flag))
				args.flags += flag;

	return args;
}

// Join arguments back into a string, ie. mode[-source][_flags]
function joinArgs(mode = null, source = null, flags = null) {
	let argsStr = mode || "";
	if (source != null && source != "") argsStr += "-" + source;
	if (flags != null && flags != "") argsStr += "_" + sortFlags(flags);
	return argsStr;
}

// Sort flags in alphabetical order
function sortFlags(flags) { return flags.split("").toSorted().join(""); }

// Generate a link to the Wayback Machine
function getWaybackLink(url, year, month) {
	const timestamp = year + `${month}`.padStart(2, "0");
	return `http://web.archive.org/web/${timestamp}/${url}`;
}

// Return directory of cached page based on its flags
function getCachedPageDir(args, compatMode) {
	let flags = args.flags || "";
	let compatPath = "";
	if (args.mode == "orphan") flags = sortFlags(flags + "n");
	if (flags.includes("n")) flags = flags.replace(/[mo]/g, "");
	if (compatMode && (!flags.includes("n") || !flags.includes("p"))) compatPath = "compat";
	return joinPath(config.dataPath, "cache/html/", flags, compatPath);
}

// Return cached page data, or null if none exists
async function getCachedPage(id, args, compatMode) {
	if (!config.doCaching) return null;
	const cachedPageFile = joinPath(getCachedPageDir(args, compatMode), `${id}`);
	return await validFile(cachedPageFile) ? await Deno.readFile(cachedPageFile) : null;
}

// Add page data to the cache, if no cache exists already
async function cachePage(id, args, compatMode, html) {
	if (!config.doCaching) return;
	const cachedPageDir = getCachedPageDir(args, compatMode);
	const cachedPageFile = joinPath(cachedPageDir, `${id}`);
	if (await validFile(cachedPageFile)) return;
	await Deno.mkdir(cachedPageDir, { recursive: true });
	await Deno.writeTextFile(cachedPageFile, html);
}

// Make an educated guess of the requesting browser's recency
function isModern(userAgent) {
	const fieldMatch = userAgent.match(/(?:Chrome|Firefox|Safari)\/[0-9.]+/) || [];
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
		errorHtml = templates.error.archive.replaceAll("{URL}", url);
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
		? titleMatch[titleMatch.length - 1][1].replaceAll(/<.*?>/gs, " ").replaceAll(/[\n\t ]+/g, " ").trim()
		: "";

	const content = html.replaceAll(
		/<title>.*?<\/title>/gis,
		"",
	).replaceAll(
		/<[^>]+alt {0,}= {0,}"(.*?)".*?>/gis,
		" $1 "
	).replaceAll(
		/<[^>]+alt {0,}= {0,}([^ >]+).*?>/gis,
		" $1 "
	).replaceAll(
		/<! {0,}[-]+.*?[-]+ {0,}>/gs,
		""
	).replaceAll(
		/<.*?>/gs,
		" "
	).replaceAll(
		/[\n\t ]+/g,
		" "
	).replaceAll(
		"<", "&lt;"
	).replaceAll(
		">", "&gt;"
	).trim();

	return { title: title, content: content };
}

// Get links from the given markup and return them as fully-formed URLs
function resolveLinks(entry, mode, rawLinks, entryData) {
	const fixedLinks = [];
	if (mode > 0) {
		const comparePaths = rawLinks.map(link => {
			if (!link.isWhole) {
				const parsedUrl = URL.parse(link.rawUrl, "http://abc/" + entry.path);
				if (parsedUrl != null) return parsedUrl.pathname.substring(1).toLowerCase();
			}
			return null;
		});
		for (const compareEntry of entryData.filter(filterEntry => filterEntry.source == entry.source)) {
			if (rawLinks.length == 0) break;
			const comparePath = compareEntry.path.toLowerCase();
			for (let l = 0; l < rawLinks.length; l++)
				if (comparePaths[l] != null && comparePath == comparePaths[l]) {
					if (compareEntry.url != "") fixedLinks.push(compareEntry.url);
					rawLinks.splice(l, 1);
					comparePaths.splice(l, 1);
					l -= 1;
				}
		}
	}

	for (const link of mode == 2 ? rawLinks.filter(filterLink => filterLink.isWhole) : rawLinks) {
		const parsedUrl = URL.parse(link.rawUrl, link.baseUrl);
		if (parsedUrl != null) fixedLinks.push(parsedUrl.href);
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
		if (types[1] != "image/x-bitmap") {
			const fileInfo = decoder.decode((await new Deno.Command("file", { args: ["-b", filePath], stdout: "piped" }).output()).stdout);
			if (fileInfo.startsWith("xbm image")) return "image/x-bitmap";
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
			html = html.replaceAll(
				// Remove footer
				/\n?<hr>\n?Original: .*? \[\[<a href=".*?">Net<\/a>\]\]\n?$/gi,
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
					/(?<=<a[ \n].*?>(?:[ \n]+)?)\[(.*?)\](?=(?:[ \n]+)?<\/a>)/gis,
					'$1'
				);
			else
				html = html.replaceAll(
					// Uncomment opening link tags
					/<(?:(?:-- ?)|!(?:-- ?)?)(a[ \n].*?)(?: ?--)?>/gis,
					'<$1>'
				).replaceAll(
					// Uncomment closing link tags
					/<!?-- ?\/(a) ?-->/gi,
					'</$1>'
				).replaceAll(
					// Remove brackets surrounding link elements
					/[\[]+(<a[ \n].*?>.*?<\/a>)[\]]+/gis,
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
				.filter(link => link.isWhole && URL.canParse(link.rawUrl))
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
		case "amigaplus": {
			// Convert CD-ROM local links into path links
			html = html.replaceAll("file:///d:/Amiga_HTML/", "/");
			break;
		}
		case "netonacd": {
			// Move real URLs back to original attribute
			html = html.replaceAll(/"([^"]+)"?[ \n]+tppabs="(.*?)"/g, '"$2"');
			break;
		}
	}
	return html;
}

// Attempt to fix invalid/deprecated/non-standard markup
function improvePresentation(html, compatMode = false) {
	if (!compatMode && !flags["build"]) {
		const style = '<link rel="stylesheet" href="/presentation.css">';
		const matchHead = html.match(/<head(er)?(| .*?)>/i);
		html = matchHead != null
			? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
			: style + "\n" + html;
	}

	html = html.replaceAll(
		// Fix closing title tags with missing slash
		/<(title)>((?:(?!<\/title>).)*?)<(title)>/gis,
		'<$1>$2</$3>'
	).replaceAll(
		// Fix attributes with missing end quote
		/([a-z]+ {0,}= {0,}"[^"\n]+)(?=>(?!".*?>))/gis,
		'$1"'
	).replaceAll(
		// Remove spaces from comment closing sequences
		/(<! {0,}[-]+(?:(?!<! {0,}[-]+).)*?[-]+) {1,}>/gs,
		'$1>',
	).replaceAll(
		// Fix single-line comments with missing closing sequence
		/<!( {0,}[-]+)([^<]+)(?<![-]+ {0,})>/g,
		'<!$1$2-->'
	).replaceAll(
		// Fix multi-line comments with missing closing sequence
		/<!( {0,}[-]+)([^<]+)(?<![-]+ {0,})>(?!(?:(?!<! {0,}[-]+).)*?[-]+ {0,}>)/gs,
		'<!$1$2-->'
	).replaceAll(
		// Fix non-standard <marquee> syntax
		/<(marquee)[ ]+text {0,}= {0,}"(.*?)".*?>/gis,
		'<$1>$2</$1>'
	).replaceAll(
		// Add missing closing tags to link elements
		/(<a[ \n](?:(?!<\/a>).)*?>(?:(?!<\/a>).)*?)(?=$|<a[ \n])/gis,
		'$1</a>'
	).replaceAll(
		// Add missing closing tags to list elements
		/(<(dt|dd)>(?:(?!<\/\1>).)*?)(?=<(?:dl|dt|dd|\/dl))/gis,
		'$1</$2>'
	).replaceAll(
		// Add missing "s" to <noframe> elements
		/(?<=<\/?)noframe(?=>)/gi,
		match => match + (match == match.toUpperCase() ? "S" : "s")
	);

	// Restore <isindex> on modern browsers
	if (!compatMode) {
		const isindexExp = /<isindex.*?>/gis;
		for (let match; (match = isindexExp.exec(html)) !== null;) {
			const isindex = match[0];
			const matchPrompt = [...isindex.matchAll(/prompt {0,}= {0,}(".*?"|[^ >]+)/gis)];
			const matchAction = [...isindex.matchAll(/action {0,}= {0,}(".*?"|[^ >]+)/gis)];

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
	const baseExp = /<base[ \n]+h?ref {0,}= {0,}("(?:(?!>).)*?"|[^ >]+)/is;
	if (baseExp.test(html)) baseUrl = trimQuotes(html.match(baseExp)[1]);
	const linkExp = /((?:href|src|action|background) {0,}= {0,})("(?:(?!>).)*?"|[^ >]+)/gis;
	const links = [];
	for (let match; (match = linkExp.exec(html)) !== null;) {
		const rawUrl = trimQuotes(match[2]);
		const isWhole = /^https?:\/\//i.test(rawUrl);
		// Anchor, unarchived, and non-HTTP links should be ignored
		if (rawUrl.startsWith("#") || /^\[unarchived-(link|image)\]$/.test(rawUrl)
		|| (!isWhole && /^[a-z]+:/i.test(rawUrl)))
			continue;
		links.push({
			fullMatch: match[0],
			attribute: match[1],
			rawUrl: rawUrl,
			baseUrl: baseUrl,
			lastIndex: linkExp.lastIndex,
			isWhole: isWhole,
		});
	}
	return links;
}

// Retrieve text from file with respect to character encodings
async function getText(filePath, source) {
	if (!await validFile(filePath) || Deno.stat(filePath).size == 0) return "";
	let text;
	try {
		const decoder = new TextDecoder();
		if (source == "wwwdir") {
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
		}
		else {
			const uchardetStr = decoder.decode((await new Deno.Command("uchardet", { args: [filePath], stdout: "piped" }).output()).stdout).trim();
			if (uchardetStr != "ASCII" && uchardetStr != "UTF-8")
				text = decoder.decode((
					await new Deno.Command("iconv", { args: [filePath, "-cf", uchardetStr, "-t", "UTF-8"], stdout: "piped" }).output()
				).stdout);
			else
				text = await Deno.readTextFile(filePath);
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
function blankComments(html) { return html.replaceAll(/<! {0,}[-]+.*?[-]+ {0,}>/gs, match => " ".repeat(match.length)); }

// Remove any quotes or whitespace surrounding a string
function trimQuotes(string) { return string.trim().replace(/^"?(.*?)"?$/s, "$1").replace(/[\r\n]+/g, "").trim(); }

// Log to the appropriate locations
function logMessage(message) {
	message = `[${new Date().toLocaleString()}] ${message}`;
	if (config.logFile != "") Deno.writeTextFile(config.logFile, message + "\n", { append: true });
	if (config.logToConsole) console.log(message);
}

// Check if a file exists and is accessible
async function validFile(path) {
	try { await Deno.lstat(path); } catch { return false; }
	return true;
}