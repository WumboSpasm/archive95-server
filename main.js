import { $ } from "bun";
import { Database } from "bun:sqlite";
import { unlink } from "node:fs/promises";

const dbPath = "data/archive95.sqlite";

const staticFiles = [
    ["logo.png", "image/png"],
    ["dice.png", "image/png"],
    ["search.css", "text/css"],
    ["navbar.css", "text/css"],
    ["presentation.css", "text/css"],
];

const templates = {
    search: {
        main: await Bun.file("meta/search.html").text(),
        about: await Bun.file("meta/search_about.html").text(),
        source: await Bun.file("meta/search_source.html").text(),
        result: await Bun.file("meta/search_result.html").text(),
        navigate: await Bun.file("meta/search_navigate.html").text(),
    },
    navbar: {
        main: await Bun.file("meta/navbar.html").text(),
        archive: await Bun.file("meta/navbar_archive.html").text(),
        screenshot: await Bun.file("meta/navbar_screenshot.html").text(),
    },
    error: {
        archive: await Bun.file("meta/404_archive.html").text(),
        generic: await Bun.file("meta/404_generic.html").text(),
    },
};

const build = Bun.argv.length > 2 && Bun.argv[2] == "build";
if (build) {
    console.log("removing old database files...")
    if (await Bun.file(dbPath).exists()) await unlink(dbPath);
    if (await Bun.file(dbPath + "-shm").exists()) await unlink(dbPath + "-shm");
    if (await Bun.file(dbPath + "-wal").exists()) await unlink(dbPath + "-wal");
}

console.log("initializing database...");
const db = new Database(dbPath, {
    create: true,
    strict: true,
    readonly: !build,
});
db.exec("PRAGMA journal_mode = WAL;");

if (build) {
    const startTime = Date.now();

    const sourceData = await Promise.all((await Bun.file("data/sources.txt").text()).split(/\r?\n/g).map(async (source, s, data) => {
        source = source.split("\t");
        console.log(`[${s + 1}/${data.length}] loading source ${source[1]}...`);
        return {
            id: s,
            short: source[0],
            title: source[1],
            author: source[2],
            date: source[3],
            link: source[4],
            local: source[5].toLowerCase() == "true" ? 1 : 0
        };
    }));
    const entryData = await (async () => {
        // Load entries into chunks to improve MIME type detection speed
        console.log("splitting files into chunks...");
        const chunkSize = 50;
        let entryChunks = [];
        let currentChunk = -1;
        let entryIndex = 0;
        for (const source of sourceData) {
            for (const entryLine of (await Bun.file(`data/sources/${source.short}.txt`).text()).split(/\r?\n/g)) {
                if (entryIndex % chunkSize == 0) {
                    entryChunks.push([]);
                    currentChunk++;
                }
                const [path, url] = entryLine.split("\t");
                entryChunks[currentChunk].push({
                    compare: sanitizeUrl(url),
                    url: url,
                    path: path,
                    source: source.short,
                    type: "",
                    title: "",
                    content: "",
                });
                entryIndex++;
            }
        }

        // Detect MIME types and fill in additional entry information
        let entries = [];
        let currentEntry = 0;
        for (const chunk of entryChunks)
            entries.push(...await Promise.all(chunk.map(async entry => {
                const filePath = `data/sources/${entry.source}/${entry.path}`;
                console.log(`[${++currentEntry}/${entryIndex}] loading file ${filePath}...`);
                entry.type = await mimeType(filePath);
                if (entry.type.startsWith("text/")) {
                    const text = await Bun.file(filePath).text();
                    if (entry.type == "text/html") {
                        const html = improvePresentation(fixMarkup(text, entry), true);
                        Object.assign(entry, textContent(html));
                    }
                    else
                        entry.content = text.replaceAll(/[\r\n\t ]+/g, " ").trim();
                }
                return entry;
            })));

        // Sort entries and give them IDs based on the new order
        console.log("sorting files...");
        entries.sort((a, b) => {
            if (a.title == "") return 1;
            if (b.title == "") return -1;
            return a.title.localeCompare(b.title, "en", { sensitivity: "base" });
        });
        entries.sort((a, b) => {
            if (a.title != "" || b.title != "") return 0;
            return a.compare.localeCompare(b.compare, "en", { sensitivity: "base" });
        });
        entries.forEach((entry, e) => Object.assign(entry, { id: e }));

        return entries;
    })();
    const linkData = await (async () => {
        let links = [];
        let totalLinks = 0;
        for (const entry of entryData)
            if (entry.type == "text/html") {
                const filePath = `data/sources/${entry.source}/${entry.path}`;
                console.log(`[${totalLinks}/??] loading links from ${filePath}...`);
                const entryLinks = collectLinks(
                    await Bun.file(filePath).text(), entry,
                    sourceData.find(source => source.short == entry.source).local, entryData
                );
                totalLinks += entryLinks.length;
                links.push(...entryLinks);
            }
        return links;
    })();
    const screenshotData = await Promise.all((await Bun.file("data/screenshots.txt").text()).split(/\r?\n/g).map(async (screenshot, s, data) => {
        screenshot = screenshot.split("\t");
        console.log(`[${s + 1}/${data.length}] loading screenshot ${screenshot[0]}...`);
        return { path: screenshot[0], url: screenshot[1] };
    }));

    console.log("creating sources table...");
    db.prepare(`CREATE TABLE sources (
        id INTEGER PRIMARY KEY,
        short TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        date TEXT NOT NULL,
        link TEXT NOT NULL,
        local INTEGER NOT NULL
    )`).run();

    console.log("creating files table...");
    db.prepare(`CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        compare TEXT NOT NULL,
        url TEXT NOT NULL,
        path TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL
    )`).run();

    console.log("creating text table...");
    db.prepare(`CREATE TABLE text (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL
    )`).run();

    console.log("creating links table...");
    db.prepare(`CREATE TABLE links (
        id TEXT NOT NULL,
        compare TEXT NOT NULL
    );`).run();

    console.log("creating screenshots table...");
    db.prepare(`CREATE TABLE screenshots (
        url TEXT NOT NULL,
        path TEXT NOT NULL
    )`).run();

    console.log("adding sources to database...");
    const sourceQuery = db.prepare("INSERT INTO sources (id, short, title, author, date, link, local) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (let s = 0; s < sourceData.length; s++) {
        const source = sourceData[s];
        console.log(`[${s + 1}/${sourceData.length}] adding source ${source.short}...`)
        sourceQuery.run(source.id, source.short, source.title, source.author, source.date, source.link, source.local);
    }
    
    console.log("adding files to database...");
    const fileQuery = db.prepare("INSERT INTO files (id, compare, url, path, source, type) VALUES (?, ?, ?, ?, ?, ?)");
    const textQuery = db.prepare("INSERT INTO text (id, title, content) VALUES (?, ?, ?)");
    for (let e = 0; e < entryData.length; e++) {
        const entry = entryData[e];
        console.log(`[${e + 1}/${entryData.length}] adding file data/sources/${entry.source}/${entry.path}...`);
        fileQuery.run(entry.id, entry.compare, entry.url, entry.path, entry.source, entry.type);
        if (entry.title != "" || entry.content != "")
            textQuery.run(entry.id, entry.title, entry.content);
    }

    console.log("adding links to database...");
    const linkQuery = db.prepare("INSERT INTO links (id, compare) VALUES (?, ?)");
    for (let l = 0; l < linkData.length; l++) {
        const link = linkData[l];
        console.log(`[${l + 1}/${linkData.length}] adding link ${link.compare}...`);
        linkQuery.run(link.id, link.compare);
    }

    console.log("adding screenshots to database...");
    const screenshotQuery = db.prepare("INSERT INTO screenshots (url, path) VALUES (?, ?)");
    for (let s = 0; s < screenshotData.length; s++) {
        const screenshot = screenshotData[s];
        console.log(`[${s + 1}/${screenshotData.length}] adding screenshot ${screenshot.path}...`);
        screenshotQuery.run(screenshot.url, screenshot.path);
    }

    const timeElapsed = Date.now() - startTime;
    const secondsElapsed = Math.floor(timeElapsed / 1000);
    const minutesElapsed = Math.floor(secondsElapsed / 60);
    const hoursElapsed = Math.floor(minutesElapsed / 60);
    console.log(`built database in ${hoursElapsed} hours, ${minutesElapsed % 60} minutes, and ${secondsElapsed % 60} seconds`);

    db.close();
    process.exit();
}

const sourceInfo = db.prepare("SELECT * FROM sources").all();

class Query {
    static possibleModes = ["view", "orphan", "raw", "random"];
    static possibleFlags = ["e", "m", "n", "o", "p"];

    args = {
        mode: "",
        source: "",
        flags: "",
    };
    url = "";

    archives = [];
    selectedArchive = 0;

    entry = null;
    source = null;

    constructor(url, args) {
        // mode[-source][_flags]
        const argsA = args.split("_");
        const argsB = argsA[0].split("-");
        if (this.constructor.possibleModes.some(mode => mode == argsB[0]))
            this.args.mode = argsB[0];
        else
            return;
        if (argsB.length > 1 && sourceInfo.some(source => source.short == argsB[1]))
            this.args.source = argsB[1];
        if (argsA.length > 1)
            for (const flag of this.constructor.possibleFlags)
                if (argsA[1].includes(flag))
                    this.args.flags += flag;
        
        const source = this.args.source;
        if (this.args.source != "") this.args.source = "-" + this.args.source;
        if (this.args.flags != "") this.args.flags = "_" + this.args.flags;

        if (this.args.mode == "random") {
            let whereConditions = [];
            let whereParameters = [];
            if (!this.args.flags.includes("m"))
                whereConditions.push('type = "text/html"');
            if (!this.args.flags.includes("o"))
                whereConditions.push('compare != ""');
            if (this.args.source != "") {
                whereConditions.push("source = ?");
                whereParameters.push(source);
            }
            this.entry = db.prepare(
                `SELECT url, source FROM files WHERE ${whereConditions.join(" AND ")} ORDER BY random() LIMIT 1`
            ).get(...whereParameters);
            this.url = this.entry.url;
            this.archives = [this.entry];
            return;
        }
        else if (url != "")
            this.url = url;
        else
            return;
        
        if (["orphan", "raw"].some(mode => mode == this.args.mode)) {
            if (this.args.source == "") return;
            this.archives = db.prepare("SELECT * FROM files WHERE source = ? AND path = ?").all(source, this.url);
            if (this.archives.length == 0) return;
        }
        else {
            const compareUrl = sanitizeUrl(this.url);
            this.archives = db.prepare("SELECT * FROM files WHERE compare = ?").all(compareUrl);
            if (this.archives.length > 1) {
                this.archives.sort((a, b) => {
                    const asort = sourceInfo.find(source => source.short == a.source).id;
                    const bsort = sourceInfo.find(source => source.short == b.source).id;
                    return asort - bsort;
                });
    
                if (source != "") {
                    let selectedArchive = this.archives.findIndex(archive => 
                        archive.source == source && archive.url == this.url
                    );
                    if (selectedArchive == -1)
                        selectedArchive = this.archives.findIndex(archive => 
                            archive.source == source && sanitizeUrl(archive.url) == compareUrl
                        );
                    this.selectedArchive = Math.max(0, selectedArchive);
                }
            }
            else if (this.archives.length == 0)
                return;
        }

        this.entry = this.archives[this.selectedArchive];
        this.source = sourceInfo.find(source => source.short == this.entry.source);
    }
}

const server = Bun.serve({
    port: 8989,
    hostname: "127.0.0.1",
    async fetch(request) {
        const requestUrl = new URL(request.url);
        const requestPath = requestUrl.pathname.replace(/^[/]+/, "");
        if (requestPath == "")
            return new Response(prepareSearch(requestUrl.searchParams), { headers: { "Content-Type": "text/html;charset=utf-8" } });

        // Serve static files
        for (const exception of staticFiles.concat(sourceInfo.map(source => [source.short + ".png", "image/png"])))
            if (requestPath == exception[0])
                return new Response(Bun.file("meta/" + exception[0]), { headers: { "Content-Type": exception[1] } });
        
        // Serve page screenshots
        if (["screenshots/", "thumbnails/"].some(dir => requestPath.startsWith(dir))) {
            const screenshot = db.prepare("SELECT path FROM screenshots WHERE path = ?").get(requestPath.substring(requestPath.indexOf("/") + 1));
            if (screenshot != null) {
                if (requestPath.startsWith("screenshots/"))
                    return new Response(Bun.file("data/screenshots/" + screenshot.path), { headers: { "Content-Type": "image/png" } });
                else {
                    const thumbnail = await $`convert ${"data/screenshots/" + screenshot.path} -geometry x64 -`.blob();
                    return new Response(thumbnail, { headers: { "Content-Type": "image/png" } });
                }
            }
        }

        const slashIndex = requestPath.indexOf("/");
        let url, args;
        if (slashIndex != -1) {
            url = requestPath.substring(slashIndex + 1) + requestUrl.search;
            args = requestPath.substring(0, slashIndex);
        }
        else {
            url = "";
            args = requestPath;
        }

        // Extract useful information out of request
        const query = new Query(url, args);
        if (query.entry == null)
            return await error(query.args.mode != "" ? query.url : null);
        else if (query.args.mode == "random")
            return Response.redirect(
                query.entry.compare != ""
                    ? `/view-${query.entry.source}${query.args.flags}/${query.entry.url}`
                    : `/orphan-${query.entry.source}${query.args.flags}/${query.entry.path}`
            );

        const filePath = `data/sources/${query.entry.source}/${query.entry.path}`;
        const contentType = query.entry.type == "text/html" ? (query.entry.type + ";charset=utf-8") : query.entry.type;

        const file = Bun.file(filePath);

        if (["view", "orphan"].some(mode => mode == query.args.mode) && !query.args.flags.includes("p") && query.entry.type == "image/x-xbitmap")
            // Convert XBM to PNG
            return new Response(await $`convert ${filePath} PNG:-`.blob(), { headers: { "Content-Type": "image/png" } });
        else if (query.args.mode == "raw" || query.entry.type != "text/html")
            // Display raw or non-HTML files verbatim
            return new Response(file, { headers: { "Content-Type": contentType }});
        
        return new Response(await prepareArchivedPage(file, query), { headers: { "Content-Type": contentType } });
    }
});
console.log("server started at " + server.url);

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
function prepareSearch(params) {
    const search = {
        inUrl: !params.has("in") || params.has("in", "url"),
        inTitle: !params.has("in") || params.has("in", "title"),
        inContent: !params.has("in") || params.has("in", "content"),
        formatsAll: !params.has("formats") || params.get("formats") == "all",
        formatsText: params.get("formats") == "text",
        formatsMedia: params.get("formats") == "media",
    };

    let html = templates.search.main
        .replace("{QUERY}", sanitizeInject((params.get("query") || "").replaceAll("&", "&amp;")))
        .replace("{INURL}", search.inUrl ? " checked" : "")
        .replace("{INTITLE}", search.inTitle ? " checked" : "")
        .replace("{INCONTENT}", search.inContent ? " checked" : "")
        .replace("{FORMATSALL}", search.formatsAll ? " checked" : "")
        .replace("{FORMATSTEXT}", search.formatsText ? " checked" : "")
        .replace("{FORMATSMEDIA}", search.formatsMedia ? " checked" : "");
    
    if (params.has("query") && params.get("query").length >= 3) {
        let whereConditions = [];
        if (search.inUrl)
            whereConditions.push("url LIKE ?1");
        if (search.inTitle)
            whereConditions.push("title LIKE ?1");
        if (search.inContent)
            whereConditions.push("content LIKE ?1");

        let searchString = params.get("query");
        try { searchString = decodeURIComponent(searchString); } catch { }
        searchString = searchString.toLowerCase();

        // Escape any wildcard characters that exist in the search query
        if (/[%_^]/g.test(searchString))
            whereConditions = whereConditions.map(condition => `(${condition} ESCAPE "^")`);

        let whereString = whereConditions.join(` OR `);
        if (search.formatsText)
            whereString = `type LIKE "text/%" AND ${whereString}`;
        else if (search.formatsMedia)
            whereString = `type NOT LIKE "text/%" AND ${whereString}`;
        
        // TODO: consider adding true SQLite pagination if this causes problems
        const searchQuery = db.prepare(`
            SELECT compare, url, path, source, text.title, text.content FROM files
            LEFT JOIN text ON files.id = text.id 
            WHERE ${whereString} ORDER BY title LIKE ?1 DESC, files.id ASC
            LIMIT 1000
        `).all(`%${searchString.replaceAll(/([%_^])/g, '^$1')}%`);

        const entriesPerPage = 50;
        const totalPages = Math.ceil(searchQuery.length / entriesPerPage);
        const currentPage = Math.max(1, Math.min(totalPages, parseInt(params.get("page")) || 1));
        const entryOffset = (currentPage - 1) * entriesPerPage;

        let results = [];
        for (const result of searchQuery.slice(entryOffset, entryOffset + entriesPerPage)) {
            let titleString = sanitizeInject(result.title || "");
            let titleMatchIndex = -1;
            if (titleString != "") {
                if (search.inTitle && (titleMatchIndex = titleString.toLowerCase().indexOf(searchString)) != -1)
                    titleString =
                        titleString.substring(0, titleMatchIndex) +
                        "<b>" + titleString.substring(titleMatchIndex, titleMatchIndex + searchString.length) + "</b>" +
                        titleString.substring(titleMatchIndex + searchString.length);
            }
            else
                titleString = result.compare;
            
            let urlString = sanitizeInject(result.url || "");
            let urlMatchIndex = -1;
            if (search.inUrl && (urlMatchIndex = urlString.toLowerCase().indexOf(searchString)) != -1)
                urlString =
                    urlString.substring(0, urlMatchIndex) +
                    "<b>" + urlString.substring(urlMatchIndex, urlMatchIndex + searchString.length) + "</b>" +
                    urlString.substring(urlMatchIndex + searchString.length);
            
            let contentString = result.content || "";
            let contentMatchIndex = -1;
            if (search.inContent && (contentMatchIndex = contentString.toLowerCase().indexOf(searchString)) != -1) {
                const minBound = contentMatchIndex - 30;
                const maxBound = minBound + 200;
                contentString = sanitizeInject(
                    contentString.substring(minBound, contentMatchIndex) +
                    "<b>" + contentString.substring(contentMatchIndex, contentMatchIndex + searchString.length) + "</b>" +
                    contentString.substring(contentMatchIndex + searchString.length, maxBound)
                ).trim();
                if (minBound > 0) contentString = "&hellip;" + contentString;
            }
            else
                contentString = sanitizeInject(contentString.substring(0, 200));

            results.push(
                templates.search.result
                    .replace("{ARCHIVE}", `/view-${result.source}/${result.url}`)
                    .replace("{TITLE}", titleString)
                    .replace("{URL}", urlString)
                    .replace("{SOURCE}", result.source)
                    .replace("{TEXT}", contentString)
            );
        }

        params.delete("page");
        const navigate = templates.search.navigate
            .replace("{TOTAL}", searchQuery.length)
            .replace("{PREVIOUS}", currentPage == 1 ? "&lt;&lt;" : `<a href="?${params.toString()}&page=${currentPage - 1}">&lt;&lt;</a>`)
            .replace("{CURRENT}", currentPage)
            .replace("{TOTAL}", totalPages)
            .replace("{NEXT}", currentPage == totalPages ? "&gt;&gt;" : `<a href="?${params.toString()}&page=${currentPage + 1}">&gt;&gt;</a>`);
        results.unshift(navigate);
        if (totalPages > 1 && currentPage != totalPages)
            results.push(navigate);
        
        const resultsString = searchQuery.length == 0 ? "No results were found for the given query." : results.join("\n");
        html = html
            .replace("{HEADER}", "Search results")
            .replace("{CONTENT}", resultsString);
    }
    else {
        const sourceQuery = db.prepare(`
            SELECT sources.*, COUNT() AS size FROM files
            LEFT JOIN sources ON sources.short = files.source
            WHERE url != "" GROUP BY source ORDER BY sources.id
        `).all();
        let sources = [];
        for (const source of sourceQuery)
            sources.push(
                templates.search.source
                    .replace("{LINK}", source.link)
                    .replace("{TITLE}", source.title)
                    .replace("{AUTHOR}", source.author)
                    .replace("{DATE}", source.date)
                    .replace("{COUNT}", source.size.toLocaleString())
            );

        const about = templates.search.about
            .replace("{SOURCES}", sources.join("\n"))
            .replace("{TOTAL}", sourceQuery.reduce((total, source) => total + source.size, 0).toLocaleString());

        html = html
            .replace("{HEADER}", "About this website")
            .replace("{CONTENT}", about);
    }

    return html;
}

// Make adjustments to page markup according to flags
async function prepareArchivedPage(file, query) {
    let html = await file.text();

    html = fixMarkup(html, query.entry);
    textContent(html);
    html = redirectLinks(html, query);
    
    if (!query.args.flags.includes("p"))
        html = improvePresentation(html);
    
    if (query.args.mode == "view" && !query.args.flags.includes("n"))
        html = await injectNavbar(html, query);

    return html;
}

// Fix undesirable markup before making any other changes
function fixMarkup(html, entry) {
    // Revert markup alterations specific to Einblicke ins Internet
    if (entry.source == "einblicke")
        html = html.replaceAll(
            // Remove footer
            /\r?\n?<hr>\r?\n?Original: .*? \[\[<a href=".*?">Net<\/a>\]\]\r?\n?$/gi,
            ''
        ).replaceAll(
            // Remove broken image URLs and non-original alt attributes
            /<(img .*?src=)"(?:[./]+|)(?:link.gif|teufel.gif|grey.gif)"(?: alt="\[(?:image|defekt)\]"|)(.*?)>/gis,
            '<$1"[unarchived-image]"$2>'
        ).replaceAll(
            // Remove broken page warning
            /^<html><body>\r?\n?<img src=".*?noise\.gif">\r?\n?<strong>Vorsicht: Diese Seite k&ouml;nnte defekt sein!<\/strong>\r?\n?\r?\n?<hr>\r?\n?/gi,
            ''
        ).replaceAll(
            // Replace missing form elements with neater placeholder
            /<p>\r?\n?<strong>Hier sollte eigentlich ein Dialog stattfinden!<\/strong>\r?\n?\[\[<a href=".*?">Net<\/a>\]\]\r?\n?<p>\r?\n?/gi,
            '<p>[[ Unarchived form element ]]</p>'
        ).replaceAll(
            // Move external links to original link element
            /(<a (?:(?!<\/a>).)*?href=")(?:[./]+|)fehler.htm("(?:(?!<\/a>).)*?<\/a>) \[\[<a href="(.*?)">Net<\/a>\]\]/gis,
            '$1$3$2'
        ).replaceAll(
            // Handle extreme edge cases where an error link doesn't have an accompanying external link
            /(<a .*?href=")(?:[./]+|)fehler.htm(".*?>.*?<\/a>)/gis,
            `$1[unarchived-link]$2`
        );
    
    // Fix anomaly with HTML files in the Edu/ directory of the Silicon Surf Promotional CD
    if (entry.path.startsWith("Edu/"))
        html = html.replaceAll(/(?<!")\.\.\//g, '/');

    html = html.replaceAll(
        // Fix attributes with missing quotation mark
        /<([^!].*?= {0,}"(?:(?!").)*?)>/gs,
        '<$1">'
    ).replaceAll(
        // Fix comments with missing double hyphen
        /<!( {0,}[-]+)([^<]+[^- <])>/g,
        '<!$1$2-->'
    ).replaceAll(
        // Close any remaining never-ending comments
        /<!( {0,}[-]+(?:(?![-]+ {0,}>).)*?)>((?:(?![-]+ {0,}>).)*$)/gs,
        '<!$1-->$2'
    ).replaceAll(
        // Add missing closing tags to link elements
        /(<a (?:(?!<\/a>).)*?>(?:(?!<\/a>).)*?)(?=$|<a )/gis,
        '$1</a>'
    ).replaceAll(
        // Add missing closing tags to list elements
        /(<(dt|dd)>(?:(?!<\/\1>).)*?)(?=<(?:dl|dt|dd|\/dl))/gis,
        '$1</$2>'
    );

    return html;
}

// Point links to archives, or the original URLs if "e" flag is enabled
function redirectLinks(html, query) {
    let unmatchedLinks = getLinks(html).map(link => {
        const matchStart = link.index - link.tag.length;
        const matchEnd = link.index;
        const parsedUrl = URL.parse(link.original, query.entry.url);
        if (parsedUrl != null)
            return {...link,
                url: parsedUrl.href,
                compareUrl: sanitizeUrl(parsedUrl.href),
                start: matchStart,
                end: matchEnd,
            };
        else
            return null;
    }).filter(link => link != null);
    if (unmatchedLinks.length == 0) return html;

    let matchedLinks = [];

    // Check for path matches (needed for sources that have their own filesystems)
    if (query.source.local) {
        const comparePaths = unmatchedLinks.map(link => {
            if (!link.whole) {
                const parsedUrl = URL.parse(link.original, "http://abc/" + query.entry.path);
                if (parsedUrl != null) return parsedUrl.pathname.substring(1);
            }
            return null;
        });
        if (comparePaths.length > 0) {
            const comparePathsDeduped = [...new Set(comparePaths.filter(path => path != null))];
            const entryQuery = db.prepare(`SELECT compare, url, path, source FROM files WHERE source = ? AND path IN (${
                Array(comparePathsDeduped.length).fill("?").join(", ")
            })`).all(query.entry.source, ...comparePathsDeduped);

            const orphanFlags = query.args.flags.replace(/n/, "").replace(/^_$/, "");
            for (const entry of entryQuery)
                for (let l = 0; l < unmatchedLinks.length; l++)
                    if (comparePaths[l] != null && entry.path == comparePaths[l]) {
                        if (query.args.flags.includes("e"))
                            unmatchedLinks[l].url = entry.url != "" ? entry.url : entry.path;
                        else
                            unmatchedLinks[l].url = entry.url != ""
                                ? `/view-${query.entry.source}${query.args.flags}/${entry.url}`
                                : `/orphan-${query.entry.source}${orphanFlags}/${entry.path}`;
                        matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
                        comparePaths.splice(l, 1);
                        l -= 1;
                    }
        }
    }

    if (!query.args.flags.includes("e")) {
        const compareUrls = [...new Set(unmatchedLinks.map(link => link.compareUrl))];
        const entryQuery = db.prepare(`SELECT compare, path, source FROM files WHERE compare IN (${
            Array(compareUrls.length).fill("?").join(", ")
        })`).all(...compareUrls);

        if (entryQuery.length > 0) {
            // Check for source-local matches first
            const sourceLocalEntries = entryQuery.filter(entry => entry.source == query.entry.source);
            if (sourceLocalEntries.length > 0)
                for (const entry of sourceLocalEntries)
                    for (let l = 0; l < unmatchedLinks.length; l++)
                        if (entry.compare == unmatchedLinks[l].compareUrl) {
                            unmatchedLinks[l].url = `/view-${query.entry.source}${query.args.flags}/${unmatchedLinks[l].url}`;
                            matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
                            l -= 1;
                        }
                    
            // Then for matches anywhere else
            const sourceExternalEntries = entryQuery.filter(entry => entry.source != query.entry.source);
            if (unmatchedLinks.length > 0 && sourceExternalEntries.length > 0) {
                for (const entry of sourceExternalEntries)
                    for (let l = 0; l < unmatchedLinks.length; l++)
                        if (entry.compare == unmatchedLinks[l].compareUrl) {
                            unmatchedLinks[l].url = `/view-${entry.source}${query.args.flags}/${unmatchedLinks[l].url}`;
                            matchedLinks.push(unmatchedLinks.splice(l, 1)[0]);
                            l -= 1;
                        }
            }
        }
    }

    // Point all clickable links to the Wayback Machine, and everything else to an invalid URL
    // We shouldn't be loading any content off of Wayback
    if (!query.args.flags.includes("e"))
        for (let l = 0; l < unmatchedLinks.length; l++)
            unmatchedLinks[l].url = /^a /i.test(unmatchedLinks[l].before)
                ? ("https://web.archive.org/web/0/" + unmatchedLinks[l].url)
                : `/view-${query.entry.source}${query.args.flags}/${unmatchedLinks[l].url}`;

    // Update markup with new links
    let offset = 0;
    for (const link of unmatchedLinks.concat(matchedLinks).toSorted((a, b) => a.start - b.start)) {
        const tag = `<${link.before}"${link.url}"${link.after}>`;
        html = html.substring(0, link.start + offset) + tag + html.substring(link.end + offset);
        offset += tag.length - link.tag.length;
    }

    return html;
}

function collectLinks(html, entry, local, entryData) {
    let rawLinks = getLinks(html).map(link => link.original);

    let links = [];
    if (local) {
        const comparePaths = rawLinks.map(link => {
            if (!link.whole) {
                const parsedUrl = URL.parse(link, "http://abc/" + entry.path);
                if (parsedUrl != null) return parsedUrl.pathname.substring(1);
            }
            return null;
        });
        for (const compareEntry of entryData.filter(filterEntry => filterEntry.source == entry.source)) {
            if (rawLinks.length == 0) break;
            for (let l = 0; l < rawLinks.length; l++)
                if (comparePaths[l] != null && compareEntry.path == comparePaths[l]) {
                    if (compareEntry.url != "") links.push(compareEntry.url);
                    rawLinks.splice(l, 1);
                    comparePaths.splice(l, 1);
                    l -= 1;
                }
        }
    }

    for (const link of rawLinks) {
        const parsedUrl = URL.parse(link, entry.url);
        if (parsedUrl != null) links.push(parsedUrl.href);
    }

    return [...new Set(links.map(link => sanitizeUrl(link)))].map(compare => ({ id: entry.id, compare: compare }));
}

// Fix elements that do not display correctly on modern browsers
function improvePresentation(html, buildMode = false) {
    if (!buildMode) {
        const style = '<link rel="stylesheet" href="/presentation.css">';
        const matchHead = html.match(/<head(er)?(| .*?)>/i);
        html = matchHead != null
            ? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
            : style + "\n" + html;
    }

    // Fix non-standard <marquee> syntax
    html = html.replaceAll(
        /<(marquee)[ ]+text {0,}= {0,}"(.*?)".*?>/gis,
        '<$1>$2</$1>'
    );

    // Restore <isindex> on modern browsers
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

    return html;
}

// Display navigation bar
async function injectNavbar(html, query) {
    let navbar = templates.navbar.main
        .replaceAll("{URL}", query.entry.url)
        .replaceAll("{WAYBACK}", "https://web.archive.org/web/0/" + query.entry.url)
        .replaceAll("{RAW}", `/raw${query.args.source}/${query.entry.path}`)
        .replaceAll("{HIDE}", `/view${query.args.source}${(query.args.flags.startsWith("_") ? (query.args.flags + "n") : "_n")}/${query.entry.url}`)
        .replaceAll("{RANDOM}", `/random${query.args.flags}/`);
    
    let archives = [];
    for (let a = 0; a < query.archives.length; a++) {
        const archive = query.archives[a];
        const source = sourceInfo.find(source => source.short == archive.source);
        archives.push(
            templates.navbar.archive
                .replaceAll("{ACTIVE}", a == query.selectedArchive ? ' class="navbar-active"' : "")
                .replaceAll("{URL}", `/view-${source.short}${query.args.flags}/${archive.url}`)
                .replaceAll("{ICON}", `/${source.short}.png`)
                .replaceAll("{TITLE}", source.title)
                .replaceAll("{DATE}", source.date)
        );
    }
    navbar = navbar.replaceAll("{ARCHIVES}", archives.join("\n"));

    let screenshotPath = "";
    let screenshotQuery = db.prepare("SELECT path FROM screenshots WHERE url = ?").get(query.entry.url);
    if (screenshotQuery != null)
        screenshotPath = screenshotQuery.path;
    else {
        const testUrls = [...new Set(query.archives.toSpliced(query.selectedArchive, 1).map(archive => archive.url))];
        screenshotQuery = db.prepare(
            `SELECT path FROM screenshots WHERE url in (${Array(testUrls.length).fill("?").join(", ")})`
        ).get(...testUrls);
        if (screenshotQuery != null)
            screenshotPath = screenshotQuery.path;
    }
    if (screenshotPath != "") {
        const screenshot = templates.navbar.screenshot
            .replaceAll("{IMAGE}", "/screenshots/" + screenshotPath)
            .replaceAll("{THUMB}", "/thumbnails/" + screenshotPath);
        navbar = navbar.replaceAll("{SCREENSHOT}", screenshot);
    }
    else
        navbar = navbar.replaceAll("{SCREENSHOT}", "");

    const style = '<link rel="stylesheet" href="/navbar.css">';
    const matchHead = html.match(/<head(er)?(| .*?)>/i);
    html = matchHead != null
        ? (html.substring(0, matchHead.index + matchHead[0].length) + "\n" + style + html.substring(matchHead.index + matchHead[0].length))
        : style + "\n" + html;
    
    const padding = '<div style="height:120px"></div>';
    const bodyCloseIndex = html.search(/(?:<\/body>(?:[ \r\n\t]+<\/html>)?|<\/html>)(?:[ \r\n\t]+|)$/i);
    html = bodyCloseIndex != -1
        ? (html.substring(0, bodyCloseIndex) + padding + "\n" + navbar + "\n" + html.substring(bodyCloseIndex))
        : html + "\n" + padding + "\n" + navbar;

    return html;
}

// Find and return links in the given markup, without performing any operations
function getLinks(html) {
    const linkExp = /<([a-z0-9]+(?: |[^>]+)(?:href|src|action|background) {0,}= {0,})(".*?"|[^ >]+)(.*?)>/gis;
    let links = [];
    for (let match; (match = linkExp.exec(html)) !== null;) {
        const matchUrl = trimQuotes(match[2]);
        const wholeLink = /^https?:\/\//i.test(matchUrl);
        // Anchor, unarchived, and non-HTTP links should be ignored
        if (matchUrl.startsWith("#") || /^\[unarchived-(link|image)\]$/.test(matchUrl)
        || (!wholeLink && /^[a-z]+:/i.test(matchUrl)))
            continue;
        links.push({
            tag: match[0],
            before: match[1],
            after: match[3],
            original: matchUrl,
            index: linkExp.lastIndex,
            whole: wholeLink,
        });
    }
    return links;
}

// Identify the file type by contents, or by file extension if returned type is too basic
async function mimeType(filePath) {
    const types = (await Promise.all([
        $`mimetype -bM "${filePath}"`.text(),
        $`mimetype -b "${filePath}"`.text()
    ])).map(t => t.trim());
    return (types[0].startsWith("text/") || (types[0] == "application/octet-stream" && !types[1].startsWith("text/"))) ? types[1] : types[0];
}

// Strip the URL down to its bare components, for comparison purposes
function sanitizeUrl(url) {
    try { url = decodeURIComponent(url); } catch { }
    return url.toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/^([^/]+):80(?:80)?($|\/)/, "$1$2")
        .replace(/index.html?$/, "")
        .replace(/\/$/, "");
}

// Get rid of quotes surrounding a string
function trimQuotes(string) { return string.trim().replace(/^"(.*?)"$/s, "$1"); }

// Display error page
async function error(url) {
    let errorHtml, status;
    if (url) {
        errorHtml = templates.error.archive.replaceAll("{URL}", url);
        status = 404;
    }
    else {
        errorHtml = templates.error.generic;
        status = 400;
    }
    return new Response(errorHtml, { headers: { "Content-Type": "text/html" }, status: status });
}

// Get the title and all visible text on a page
function textContent(html) {
    const titleMatch = [...html.matchAll(/<title>(((?!<\/title>).)*?)<\/title>/gis)];
    const title = titleMatch.length > 0
        ? titleMatch[titleMatch.length - 1][1].replaceAll(/<.*?>/gs, " ").replaceAll(/[\r\n\t ]+/g, " ").trim()
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
        /[\r\n\t ]+/g,
        " "
    ).trim();

    return { title: title, content: content };
}