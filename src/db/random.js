import * as Comlink from 'comlink';
import { Database } from '@db/sqlite';

let database, cacheSize;
const cache = {};

Comlink.expose({
	open: (path, randomCacheSize) => {
		database = new Database(path, { readonly: true });
		database.exec('PRAGMA journal_mode = OFF');
		database.exec('PRAGMA shrink_memory');
		database.exec('PRAGMA synchronous = off');
		cacheSize = randomCacheSize;
	},
	query: (doHtmlOnly, doUrlsOnly, sourceId) => {
		if (!database)
			return null;

		const arrId = (sourceId || '') + '_' + (!doHtmlOnly ? 'm' : '') + (doUrlsOnly ? 'o' : '');
		if (cache[arrId] === undefined || cache[arrId].length == 0) {
			const whereConditions = [];
			const whereParameters = [];
			if (doHtmlOnly)
				whereConditions.push("type = 'text/html'");
			if (doUrlsOnly)
				whereConditions.push('orphan = 0');
			if (sourceId !== undefined) {
				whereConditions.push(`source = ?`);
				whereParameters.push(sourceId);
			}

			const randomEntries = database.prepare(`
				SELECT source, offset, url FROM search
				${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}
				ORDER BY random() LIMIT ?
			`).all(...whereParameters, cacheSize);

			if (cache[arrId] === undefined)
				cache[arrId] = randomEntries;
			else
				cache[arrId].push(...randomEntries);
		}

		return cache[arrId].pop();
	},
	close: () => database?.close(),
});

self.postMessage('ready');