import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { categories, type Article, type Board } from '../shared/model.js';
import { fillEdition, LAYOUT_VERSION, newReader, type Reader } from './board.js';
import { isFresh } from './ingest.js';

type Edition = NonNullable<Board['edition']>;
type Mode = Board['mode'];

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS readers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        reader_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (reader_id, id)
      );
      CREATE TABLE IF NOT EXISTS edition (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS editions (id TEXT PRIMARY KEY, at TEXT NOT NULL);
      INSERT OR IGNORE INTO editions (id, at) SELECT id, at FROM edition;
    `);
  }

  close() {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  catalog(): Article[] {
    return this.db.prepare('SELECT data FROM articles ORDER BY rowid').all().map(row => JSON.parse(row.data as string));
  }

  edition(): Edition | null {
    return this.db.prepare('SELECT id, at FROM edition WHERE singleton = 1').get() as Edition | undefined ?? null;
  }

  personalQueries(): string[] {
    const labels = this.db.prepare('SELECT data FROM readers').all().flatMap(row =>
      (JSON.parse(row.data as string) as Reader).custom.map(category => category.label));
    return [...new Set(labels)];
  }

  saveEdition(edition: Edition, articles: Article[], keywordUpdates: Article[] = []) {
    return this.transaction(() => {
      let changes = 0;
      const upsert = this.db.prepare('INSERT OR IGNORE INTO articles (id, event_id, data) VALUES (?, ?, ?)');
      const update = this.db.prepare('UPDATE articles SET data = ? WHERE id = ?');
      for (const article of articles) changes += Number(upsert.run(article.id, article.eventId, JSON.stringify(article)).changes);
      for (const article of keywordUpdates) changes += Number(update.run(JSON.stringify(article), article.id).changes);
      if (changes) {
        this.db.prepare('INSERT OR IGNORE INTO editions (id, at) VALUES (?, ?)').run(edition.id, edition.at);
        this.db.prepare(`
          INSERT INTO edition (singleton, id, at) VALUES (1, ?, ?)
          ON CONFLICT (singleton) DO UPDATE SET id = excluded.id, at = excluded.at
        `).run(edition.id, edition.at);
      }
      return changes;
    });
  }

  board(
    id: string, mode: Mode, refresh: Board['refresh'], operationId?: string,
    change?: (reader: Reader, catalog: Article[], fresh: Article[], now: number) => void,
  ): Board {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT data FROM readers WHERE id = ?').get(id);
      const reader = row ? JSON.parse(row.data as string) as Reader : newReader();
      const before = JSON.stringify(reader);
      const catalog = this.catalog();
      const edition = this.edition();
      const now = Date.now();
      const fresh = mode === 'demo' ? catalog : catalog.filter(article => isFresh(article, now));
      if (edition && (!operationId || !reader.editionId || reader.layoutVersion !== LAYOUT_VERSION)) {
        fillEdition(reader, catalog, edition, mode === 'demo' ? () => 0 : Math.random, fresh);
      }
      if (operationId && change && !this.db.prepare('SELECT 1 FROM requests WHERE reader_id = ? AND id = ?').get(id, operationId)) {
        change(reader, catalog, fresh, now);
        this.db.prepare('INSERT INTO requests (reader_id, id) VALUES (?, ?)').run(id, operationId);
      }
      const after = JSON.stringify(reader);
      if (!row || before !== after) this.db.prepare(`
        INSERT INTO readers (id, data) VALUES (?, ?)
        ON CONFLICT (id) DO UPDATE SET data = excluded.data
      `).run(id, after);
      const byId = new Map(catalog.map(article => [article.id, article]));
      const shownEdition = edition?.id === reader.editionId ? edition :
        this.db.prepare('SELECT id, at FROM editions WHERE id = ?').get(reader.editionId) as Edition | undefined;
      return {
        slots: reader.slots.map(slot => ({ ...slot, article: byId.get(slot.articleId ?? '') ?? null })),
        categories: [...categories, ...reader.custom],
        canUndo: reader.lastVote !== null,
        hasPreferences: Object.values(reader.weights).some(weight => weight !== 0) || reader.lastVote !== null,
        edition: shownEdition ?? null, mode, refresh,
      };
    });
  }
}
