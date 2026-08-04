import * as pathUtils from '@std/path';

const textTypes = JSON.parse(Deno.readTextFileSync('data/texttypes.json'));

// Attempt to load config file, otherwise use defaults
export function loadConfig(configPath) {
	globalThis.config = JSON.parse(Deno.readTextFileSync('data/config_template.json'));
	if (getPathInfo(configPath)?.isFile) {
		Object.assign(config, JSON.parse(Deno.readTextFileSync(configPath)));
		logMessage(`loaded config file at ${Deno.realPathSync(configPath)}`);
	}
	else
		logMessage('no config file found, using default config');
}

// Attempt to load blocklist and remove expired entries
export function loadBlocklist(blocklistPath) {
	globalThis.blocklist = [];
	if (getPathInfo(blocklistPath)?.isFile) {
		globalThis.blocklist = JSON.parse(Deno.readTextFileSync(blocklistPath))
			.filter(blocklistEntry => blocklistEntry.expires === null || blocklistEntry.expires > Date.now());
		Deno.writeTextFileSync(blocklistPath, JSON.stringify(blocklist, null, '\t'));
		logMessage(`loaded blocklist file at ${Deno.realPathSync(blocklistPath)}`);
	}
}

// Convert a normalized URL/path into a properly escaped directory definition for quick lookup
export function getArchiveRootDir(normalizedUrl, namespace, buildPath = config.buildPath) {
	return pathUtils.join(buildPath, namespace, normalizedUrl
		.replace(/[^a-z0-9 \/_.-]/gi, c => c.charCodeAt(0).toString(16).toUpperCase().match(/.{1,2}/g).map(h => '%' + h.padStart(2, '0')).join(''))
		.replace(/(?<=%3F.*)\//g, '%2F')
		.replace(/(?<=^|\/)\.+(?=\/|$)/g, match => '%2E'.repeat(match.length))
		.replace(/\/{2,}/g, '/'));
}

// Strip a URL down to its bare components, for comparison purposes
export function normalizeUrl(url, doLowerCase = true) {
	let normalizedUrl = safeDecode(url.replace(/#.*$/, ''));
	if (doLowerCase)
		normalizedUrl = normalizedUrl.toLowerCase();

	return normalizedUrl
		.replace(/^(?:https?|ftp):\/*/i, '')
		.replace(/^www\d{0,2}\./i, '')
		.replace(/^([^/]+):80(?:80)?($|\/)/, '$1$2')
		.replace(/\?\d+,\d+$/, '')
		.replace(/(?<!\?.*)\/(?:index\.[a-z]?html?|default\.htm)$/i, '')
		.replace(/(?<!\?.*)\/{2,}/g, '/')
		.replace(/(?<!\?.*)\/$/, '');
}

// Strip a path down to its bare components, for comparison purposes
export function normalizePath(path, doLowerCase = true) {
	let [normalizedPath, anchor] = splitAnchor(path).map(value => safeDecode(value));

	normalizedPath = normalizedPath
		.replace(/\/{2,}/g, '/')
		.replace(/\/$/, '') + anchor;
	if (doLowerCase)
		normalizedPath = normalizedPath.toLowerCase();

	return normalizedPath;
}

// Split a URL into segments for use by the directory browser
export function splitUrl(url, orphanSource = null) {
	const normalizedUrl = orphanSource !== null
		? pathUtils.join(orphanSource, normalizePath(url, false))
		: normalizeUrl(url, false);

	// The name is on purpose, FYI
	const splittedUrl = normalizedUrl.split(/(?<!\?.*)\//i);
	splittedUrl[0] = splittedUrl[0].toLowerCase();
	return splittedUrl;
}

// Extract the anchor from a URL
export function splitAnchor(url, encoded = false) {
	let anchor = '';
	const anchorMatch = url.match(encoded ? /(?:#|%23).*$/ : /#.*$/);
	if (anchorMatch !== null) {
		anchor = safeDecode(anchorMatch[0]);
		url = url.substring(0, anchorMatch.index);
	}

	return [url, anchor];
}

// Decode string without throwing an error if a single encoded character is invalid
export function safeDecode(str) {
	let decodedStr;
	try { decodedStr = decodeURIComponent(str); }
	catch {
		decodedStr = str.replace(/%[\dA-F]{2}/g, match => {
			let decodedChar;
			try { decodedChar = decodeURIComponent(match); }
			catch { decodedChar = match; }

			return decodedChar;
		});
	}

	return decodedStr;
}

// Efficiently replace slices of a string with different values
export function replaceSlices(str, slices) {
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

// Convert a date string into a number for quick comparisons
export function dateStringToNum(dateStr) {
	const cleanDateStr = dateStr.replace(/[^\d]/g, '');
	let dateNum = parseInt(cleanDateStr, 10);
	if (cleanDateStr.length < 6)
		dateNum = dateNum * 100 + 13;
	if (cleanDateStr.length < 8)
		dateNum = dateNum * 100 + 32;

	return dateNum;
}

// Determine if a given MIME type indicates that a file can be rendered in plaintext
export function isTextType(type, excludeHtml = false) {
	return textTypes.include.some(includeType => type.startsWith(includeType))
		&& !textTypes.exclude.some(excludeType => type.startsWith(excludeType) && (excludeType != 'text/html' || excludeHtml));
}

// Log to the appropriate places based on the configuration
export function logMessage(message) {
	message = `[${new Date().toLocaleString()}] ${message}`;
	if (config.logFile)
		try { Deno.writeTextFile(config.logFile, message + '\n', { append: true }); } catch {}
	if (config.logToConsole)
		console.log(message);
}

// Run Deno.lstat without throwing an error if the path doesn't exist
export function getPathInfo(path) {
	try { return Deno.lstatSync(path); } catch {}
	return null;
}