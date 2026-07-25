import * as Comlink from 'comlink';
import { Database } from '@db/sqlite';

let searchDatabase;
const randomCache = {};

Comlink.expose({
	open: (path) => {
		searchDatabase = new Database(path, { readonly: true });
		searchDatabase.exec('PRAGMA shrink_memory');
		searchDatabase.exec('PRAGMA synchronous = off');
	},
	query: (sql, ...params) => searchDatabase?.prepare(sql).all(...params),
	random: (doHtmlOnly, doUrlsOnly, sourceId, randomCacheSize = 1) => {
		if (!searchDatabase)
			return null;

		const arrId = (sourceId || '') + '_' + (!doHtmlOnly ? 'm' : '') + (doUrlsOnly ? 'o' : '');
		if (randomCache[arrId] === undefined || randomCache[arrId].length == 0) {
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

			const randomEntries = searchDatabase.prepare(`
				SELECT source, offset, url FROM search
				${whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : ''}
				ORDER BY random() LIMIT ?
			`).all(...whereParameters, randomCacheSize);

			if (randomCache[arrId] === undefined)
				randomCache[arrId] = randomEntries;
			else
				randomCache[arrId].push(...randomEntries);
		}

		return randomCache[arrId].pop();
	},
	close: () => searchDatabase?.close(),
});

self.postMessage('ready');