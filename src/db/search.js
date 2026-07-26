import * as Comlink from 'comlink';
import { Database } from '@db/sqlite';

let database;

Comlink.expose({
	open: (path) => {
		database = new Database(path, { readonly: true });
		database.exec('PRAGMA journal_mode = OFF');
		database.exec('PRAGMA shrink_memory');
		database.exec('PRAGMA synchronous = off');
	},
	query: (sql, ...params) => database?.prepare(sql).all(...params),
	close: () => database?.close(),
});

self.postMessage('ready');