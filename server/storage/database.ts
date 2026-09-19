import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { inside } from '../core/util.js';

const migrations = [
  `CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
 aggregate_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, provenance TEXT NOT NULL,
 payload TEXT NOT NULL, supersedes TEXT REFERENCES events(id));
CREATE INDEX events_aggregate_time ON events(aggregate_id, at, seq);
CREATE INDEX events_time ON events(at DESC, seq DESC);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TABLE memories (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, memory_class TEXT NOT NULL,
 status TEXT NOT NULL, project TEXT NOT NULL, tags TEXT NOT NULL, importance REAL NOT NULL,
 private INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 valid_from TEXT NOT NULL, valid_until TEXT, supersedes TEXT REFERENCES memories(id),
 fact_key TEXT NOT NULL, fact_value TEXT NOT NULL, provenance TEXT NOT NULL,
 version INTEGER NOT NULL, path TEXT UNIQUE NOT NULL, content_hash TEXT NOT NULL);
CREATE INDEX memories_project ON memories(project, status, updated_at DESC);
CREATE INDEX memories_type ON memories(type, status, updated_at DESC);
CREATE TABLE outbox (memory_id TEXT PRIMARY KEY REFERENCES memories(id), content TEXT NOT NULL, previous_hash TEXT, created_at TEXT NOT NULL);
CREATE TABLE entities (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, memory_id TEXT UNIQUE REFERENCES memories(id),
 properties TEXT NOT NULL DEFAULT '{}', provenance TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX entities_name ON entities(name COLLATE NOCASE);
CREATE TABLE relationships (
 id TEXT PRIMARY KEY, from_id TEXT NOT NULL REFERENCES entities(id), to_id TEXT NOT NULL REFERENCES entities(id),
 type TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT);
CREATE INDEX relationships_from ON relationships(from_id, valid_until);
CREATE INDEX relationships_to ON relationships(to_id, valid_until);
CREATE UNIQUE INDEX relationships_live ON relationships(from_id, to_id, type) WHERE valid_until IS NULL;
CREATE TABLE sources (
 id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
 size INTEGER NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL, memory_id TEXT REFERENCES memories(id));
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, project TEXT NOT NULL,
 due_at TEXT, memory_id TEXT REFERENCES memories(id), provenance TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL);
CREATE INDEX tasks_status ON tasks(status, due_at);
CREATE TABLE records (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL, provenance TEXT NOT NULL,
 valid_from TEXT NOT NULL, valid_until TEXT, supersedes TEXT REFERENCES records(id), created_at TEXT NOT NULL);
CREATE INDEX records_type_time ON records(type, valid_from);
CREATE TABLE proposals (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL,
 provenance TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, result_id TEXT);
CREATE INDEX proposals_status ON proposals(status, created_at);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 run_at TEXT NOT NULL, error TEXT, dedup_key TEXT);
CREATE UNIQUE INDEX jobs_dedup ON jobs(dedup_key) WHERE status IN ('queued','running');
CREATE INDEX jobs_ready ON jobs(status, run_at);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE backup_runs (id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL, manifest_hash TEXT NOT NULL);`,
  `CREATE TABLE ask_turns (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX ask_turns_time ON ask_turns(created_at DESC);`,
  // Archival events affect current-state queries. Older binaries must refuse
  // this reader version instead of silently ignoring deletion markers.
  `CREATE INDEX events_kind_aggregate ON events(kind, aggregate_id);`,
  `ALTER TABLE memories ADD COLUMN facts TEXT NOT NULL DEFAULT '[]';
UPDATE memories SET facts=json_array(json_object('key',fact_key,'value',fact_value)) WHERE fact_key!='';
CREATE TABLE erased_fingerprints (kind TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind,digest));
CREATE TABLE erasure_cleanup (id INTEGER PRIMARY KEY CHECK(id=1), files TEXT NOT NULL);`,
  `ALTER TABLE ask_turns ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX ask_turns_conversation ON ask_turns(conversation_id);
CREATE TABLE ask_chat (id INTEGER PRIMARY KEY CHECK(id=1), conversation_id TEXT NOT NULL);
INSERT INTO ask_chat VALUES (1,'legacy');`,
];
export class Storage {
  readonly root: string;
  readonly db: DatabaseSync;
  readonly index: DatabaseSync;
  constructor(root: string) {
    mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
    this.root = realpathSync(resolve(root));
    for (const dir of ['vault', 'database', 'objects', 'indexes', 'config', 'backups', 'logs'])
      mkdirSync(inside(this.root, dir), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(inside(this.root, 'database/brain.db'));
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const version = (this.db.prepare('SELECT coalesce(max(version),0) AS v FROM migrations').get() as any).v;
    if (version > migrations.length) throw new Error('This brain requires a newer application version');
    for (let i = version; i < migrations.length; i++)
      this.transaction(() => {
        this.db.exec(migrations[i]);
        this.db.prepare('INSERT INTO migrations VALUES (?,?)').run(i + 1, new Date().toISOString());
      });
    this.index = new DatabaseSync(inside(this.root, 'indexes/search.db'));
    this.index
      .exec(`PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(id UNINDEXED, title, body, tags, project, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS indexed (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_memory ON chunks(memory_id);
      CREATE TABLE IF NOT EXISTS vectors (memory_id TEXT PRIMARY KEY, hash TEXT NOT NULL, provider TEXT NOT NULL, vector TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_state (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.index.prepare('ATTACH DATABASE ? AS canonical').run(inside(this.root, 'database/brain.db'));
    if (
      !this.index
        .prepare('PRAGMA table_info(documents)')
        .all()
        .some((r) => r.name === 'facts')
    ) {
      // Derived-only upgrade: canonical memories/events/Markdown are untouched.
      this.index.exec(`BEGIN IMMEDIATE; DROP TABLE documents;
        CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED,title,body,tags,project,facts,tokenize='unicode61 remove_diacritics 2');
        DELETE FROM indexed; COMMIT;`);
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  state(key: string, value?: unknown): any {
    if (value !== undefined)
      this.db
        .prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify(value));
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as any;
    return row ? JSON.parse(row.value) : null;
  }
  close() {
    this.index.close();
    this.db.close();
  }
}
