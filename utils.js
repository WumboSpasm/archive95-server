import * as pathUtils from 'jsr:@std/path';

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
		.replace(/%3F.*$/, match => match.replaceAll('/', '%2F'))
		.replace(/(?<=^|\/)\.+(?=\/|$)/g, match => '%2E'.repeat(match.length))
		.replace(/\/{1,}/g, '/'));
}

// Strip a URL down to its bare components, for comparison purposes
export function sanitizeUrl(url) {
	return safeDecode(url).toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/^www\d{0,2}\./, '')
		.replace(/^([^/]+):80(?:80)?($|\/)/, '$1$2')
		.replace(/(?<=^[^#]+)#[^#]+$/, '')
		.replace(/index\.html?$/, '')
		.replace(/(?<!(?:\?.*|:))\/{2,}/g, '/')
		.replace(/\/$/, '');
}

// Strip a path down to its bare components, for comparison purposes
export function sanitizePath(path, keepAnchor = false) {
	let sanitizedPath = safeDecode(path).toLowerCase();
	if (!keepAnchor)
		sanitizedPath = sanitizedPath.replace(/(?<=^[^#]+)#[^#]+$/, '');

	return sanitizedPath.replace(/\/{2,}/g, '/');
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
	return Deno.spawnAndWaitSync('guestunmount', [mountPath]).success;
}