import * as Comlink from 'comlink';
import { Database } from '@db/sqlite';

let searchDatabase;

Comlink.expose({
	open: path => {
		searchDatabase = new Database(path, { readonly: true });
		searchDatabase.exec('PRAGMA shrink_memory');
		searchDatabase.exec('PRAGMA synchronous = off');
	},
	get: (sql, ...params) => searchDatabase?.prepare(sql).get(...params),
	all: (sql, ...params) => searchDatabase?.prepare(sql).all(...params),
	close: () => searchDatabase?.close(),
});

self.postMessage('ready');