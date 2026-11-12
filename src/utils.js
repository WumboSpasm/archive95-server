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
export function normalizeUrl(url, ignoreOpNames = [], detailed = false) {
	// Decode the URL and remove anchor if it exists
	const partialNormalizedUrl = safeDecode(url.replace(/#.*$/, ''))
		// Change direction of backslashes
		.replaceAll('\\', '/')
		// Remove protocol
		.replace(/^(?:https?|ftp):\/*/i, '')
		// Collapse sequences of dots in origin
		.replace(/(?<=^[^/:]*)\.{2,}/g, '.')
		// Remove trailing dot from origin
		.replace(/(?<=^[^/:]*)\.(?=[/:])/g, '')
		// Remove leading dot from origin
		.replace(/^\./, '')
		// Collapse sequences of slashes
		.replace(/(?<!\?.*)\/{2,}/g, '/')
		// Remove trailing slash
		.replace(/(?<!\?.*)\/$/, '');

	// Operations that have the potential to change the URL's destination are kept separate
	const operations = {
		convertLowerCase: url => url.toLowerCase(),
		removeWwwSubdomain: url => url.replace(/^\.*www(?:-?\d{1,2})?\.([^/]+\.)/i, '$1'),
		removeHttpPort: url => url.replace(/^([^/]+):80(?:80)?($|\/)/, '$1$2'),
		removeImagemapCoords: url => url.replace(/\?\d+,\d+$/, ''),
		removeIndexFile: url => url.replace(/(?<!\?.*)\/+(?:index\.[a-z]?html?|default\.(?:htm|asp))$/i, ''),
	};

	// Apply each operation
	let normalizedUrl = partialNormalizedUrl;
	for (const opName in operations) {
		if (!ignoreOpNames.includes(opName))
			normalizedUrl = operations[opName](normalizedUrl);
	}

	// Just return the normalized URL by default
	if (!detailed)
		return normalizedUrl;

	// Track which operations modify the result of the final normalized URL
	const opNames = Object.keys(operations);
	const successfulOpNames = {};
	for (let i = 0; i < opNames.length; i++) {
		const excludeOpName = opNames[i];
		if (ignoreOpNames.includes(excludeOpName))
			continue;

		let normalizedUrl2 = partialNormalizedUrl;
		for (const opName in operations) {
			if (!ignoreOpNames.includes(opName) && opName != excludeOpName)
				normalizedUrl2 = operations[opName](normalizedUrl2);
		}

		if (normalizedUrl != normalizedUrl2)
			successfulOpNames[excludeOpName] = Math.pow(2, i);
	}

	// Return the normalized URL as well as the names of successful operations
	return [normalizedUrl, successfulOpNames];
}

// Strip a path down to its bare components, for comparison purposes
export function normalizePath(path, convertLowerCase = true) {
	// Decode the path and extract anchor if it exists
	let [normalizedPath, anchor] = splitAnchor(path).map(value => safeDecode(value));

	normalizedPath = normalizedPath
		// Change direction of backslashes
		.replaceAll('\\', '/')
		// Collapse sequences of slashes
		.replace(/\/{2,}/g, '/')
		// Remove trailing slash
		.replace(/\/$/, '')
		// Restore anchor if it exists
		+ anchor;

	// Convert to lowercase if specified
	if (convertLowerCase)
		normalizedPath = normalizedPath.toLowerCase();

	return normalizedPath;
}

// Split a URL into segments for use by the directory browser
export function splitUrl(url, orphanSource = null) {
	const normalizedUrl = orphanSource !== null
		? pathUtils.join(orphanSource, normalizePath(url, false))
		: normalizeUrl(url, ['convertLowerCase']);

	// The name is on purpose, FYI
	const splittedUrl = normalizedUrl.split(/(?<!\?.*)[/\\]/i);
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

// Escape characters that have the potential to enable XSS injections
export function sanitizeInject(str, sanitizeAmp = true) {
	const charMap = {
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		// Not worth rendering these
		'\r': ' ',
		'\n': ' ',
	};
	if (sanitizeAmp)
		charMap['&'] = '&amp;';

	return str.replace(new RegExp(`[${Object.keys(charMap).join('')}]`, 'g'), m => charMap[m]);
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

// Determine the high-level format of a MIME type
export function getTypeFormat(type) {
	if (isTextType(type, true, false))
		return 'text';
	else if (/^(?:image|audio|video|model)\//.test(type))
		return 'media';
	else
		return 'other';
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