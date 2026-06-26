import * as pathUtils from '@std/path';

const textTypes = JSON.parse(Deno.readTextFileSync('data/texttypes.json'));

// Attempt to load config file, otherwise use defaults
export function loadConfig(configPath) {
	globalThis.config = JSON.parse(Deno.readTextFileSync('data/config_template.json'));
	if (getPathInfo(configPath)?.isFile) {
		Object.assign(config, JSON.parse(Deno.readTextFileSync(configPath)));
		logMessage(`loaded config file: ${Deno.realPathSync(configPath)}`);
	}
	else
		logMessage('no config file found, using default config');
}

// Convert a sanitized URL/path into a properly escaped directory definition for quick lookup
export function getArchiveRootDir(sanitizedUrl, namespace, mountPath) {
	return pathUtils.join(mountPath, namespace, sanitizedUrl
		.replace(/[^a-z0-9 \/_.-]/gi, c => c.charCodeAt(0).toString(16).toUpperCase().match(/.{1,2}/g).map(h => '%' + h.padStart(2, '0')).join(''))
		.replace(/(?<=%3F.*)\//g, '%2F')
		.replace(/(?<=^|\/)\.+(?=\/|$)/g, match => '%2E'.repeat(match.length))
		.replace(/\/{2,}/g, '/'));
}

// Strip a URL down to its bare components, for comparison purposes
export function sanitizeUrl(url, doLowerCase = true) {
	let sanitizedUrl = safeDecode(url);
	if (doLowerCase)
		sanitizedUrl = sanitizedUrl.toLowerCase();

	return sanitizedUrl
		.replace(/^https?:\/\//, '')
		.replace(/^www\d{0,2}\./, '')
		.replace(/^([^/]+):80(?:80)?($|\/)/, '$1$2')
		.replace(/(?<=^[^#]+)#[^#]+$/, '')
		.replace(/\?\d+,\d+$/, '')
		.replace(/(?<!\?.*)\/(?:index\.[a-z]?html?|default\.htm)$/i, '')
		.replace(/(?<!\?.*)\/{2,}/g, '/')
		.replace(/(?<!\?.*)\/$/, '');
}

// Strip a path down to its bare components, for comparison purposes
export function sanitizePath(path, keepAnchor = false, doLowerCase = true) {
	let sanitizedPath = safeDecode(path);
	if (!keepAnchor)
		sanitizedPath = sanitizedPath.replace(/(?<=^[^#]+)#[^#]+$/, '');
	if (doLowerCase)
		sanitizedPath = sanitizedPath.toLowerCase();

	return sanitizedPath.replace(/(?<!#.*)\/{2,}/g, '/');
}

// Split a URL into segments for use by the directory browser
export function splitUrl(url, orphanSource = null) {
	const sanitizedUrl = orphanSource !== null
		? pathUtils.join(orphanSource, sanitizePath(url, false, false))
		: sanitizeUrl(url, false);

	// The name is on purpose, FYI
	const splittedUrl = sanitizedUrl.split(/(?<!\?.*)\//i);
	splittedUrl[0] = splittedUrl[0].toLowerCase();
	return splittedUrl;
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
export function isTextType(type) {
	return textTypes.include.some(includeType => type.startsWith(includeType)) && !textTypes.exclude.some(excludeType => type.startsWith(excludeType));
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

// Create a filesystem image and format it
export function createVhd(vhdPath) {
	if (!Deno.spawnAndWaitSync('qemu-img', ['create', '-f', 'qcow2', '-o', 'preallocation=off', vhdPath, '16G']).success)
		return false;
	return Deno.spawnAndWaitSync('virt-format', ['--filesystem=xfs', '--format=qcow2', '-a', vhdPath]).success;
}

// (Re-)mount a filesystem image
export function mountVhd(vhdPath, mountPath, readOnly = false) {
	Deno.spawnAndWaitSync('guestunmount', [mountPath]);
	return Deno.spawnAndWaitSync('guestmount', ['-a', vhdPath, '-m', '/dev/sda1', readOnly ? '-r' : '-w', mountPath]).success;
}

// Unmount a filesystem image
export function unmountVhd(mountPath) {
	try { return Deno.spawnAndWaitSync('guestunmount', [mountPath]).success; }
	catch { return false; }
}