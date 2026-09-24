import xxhash from 'xxhash-wasm';
import * as pathUtils from '@std/path';

const { h64ToString } = await xxhash();

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

// Convert a normalized URL/path into a hash and build a directory from it
export function getArchiveRootDir(normalizedUrl, namespace, buildPath = config.buildPath) {
	const urlHash = h64ToString(normalizedUrl);
	return pathUtils.join(buildPath, namespace, urlHash.substring(0, 2), urlHash.substring(2, 4), urlHash);
}

// Strip a URL down to its bare components, for comparison purposes
export function normalizeUrl(url, doLowerCase = true) {
	// Decode the URL and remove anchor if it exists
	let normalizedUrl = safeDecode(url.replace(/#.*$/, ''));

	normalizedUrl = normalizedUrl
		// Remove protocol
		.replace(/^(?:https?|ftp):\/*/i, '')
		// Remove www subdomain
		.replace(/^\.*www\d{0,2}\.([^/]+\.)/i, '$1')
		// Remove port number if it is 80
		.replace(/^([^/]+):80(?:80)?($|\/)/, '$1$2')
		// Collapse sequences of dots in origin
		.replace(/(?<=^[^/:]*)\.{2,}/g, '.')
		// Remove trailing dot from origin
		.replace(/(?<=^[^/:]*)\.(?=[/:])/g, '')
		// Remove leading dot from origin
		.replace(/^\./, '')
		// Remove imagemap coordinates
		.replace(/\?\d+,\d+$/, '')
		// Remove index file
		.replace(/(?<!\?.*)\/(?:index\.[a-z]?html?|default\.htm)$/i, '')
		// Collapse sequences of slashes
		.replace(/(?<!\?.*)\/{2,}/g, '/')
		// Remove trailing slash
		.replace(/(?<!\?.*)\/$/, '');

	// Convert to lowercase if specified
	if (doLowerCase)
		normalizedUrl = normalizedUrl.toLowerCase();

	return normalizedUrl;
}

// Strip a path down to its bare components, for comparison purposes
export function normalizePath(path, doLowerCase = true) {
	// Decode the path and extract anchor if it exists
	let [normalizedPath, anchor] = splitAnchor(path).map(value => safeDecode(value));

	normalizedPath = normalizedPath
		// Collapse sequences of slashes
		.replace(/\/{2,}/g, '/')
		// Remove trailing slash
		.replace(/\/$/, '')
		// Restore anchor if it exists
		+ anchor;

	// Convert to lowercase if specified
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

// Determine if a given MIME type indicates that the file is text-based
export function isTextType(type, includeHtml = true, includeImages = true) {
	const matchesHtml = textTypes.html.some(includeType => type.startsWith(includeType));
	const matchesPlaintext = textTypes.plaintext.some(includeType => type.startsWith(includeType) && (!matchesHtml || includeHtml));
	const matchesImage = textTypes.image.some(includeType => type.startsWith(includeType));
	return matchesPlaintext || includeImages && matchesImage;
}

// Log to the appropriate places based on the configuration
export function logMessage(message) {
	message = `[${new Date().toLocaleString()}] ${message}`;
	const logFile = scriptContext == 'build' ? config.buildLogFile : config.serverLogFile;
	if (logFile)
		try { Deno.writeTextFile(logFile, message + '\n', { append: true }); } catch {}
	if (config.logToConsole)
		console.log(message);
}

// Run Deno.stat without throwing an error if the path doesn't exist
export function getPathInfo(path) {
	try { return Deno.statSync(path); } catch {}
	return null;
}