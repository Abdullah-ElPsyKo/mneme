import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { relative } from 'node:path';
import type { Storage } from '../storage/database.js';
import { AppError } from '../core/types.js';
import { hash, inside, parse } from '../core/util.js';
import { readMarkdown, writeMarkdown } from './markdown.js';
import type { Brain } from '../app.js';

export function erased(storage: Storage, kind: string, value: string) {
  return !!storage.db
    .prepare('SELECT 1 FROM erased_fingerprints WHERE kind=? AND digest=?')
    .get(kind, hash(value));
}
export function assertErasureComplete(storage: Storage) {
  if (storage.db.prepare('SELECT 1 FROM erasure_cleanup').get())
    throw new AppError(
      503,
      'Permanent deletion cleanup is pending. Restart Mneme to finish cleanup before using this brain.',
    );
}
// A durable, content-free journal bridges the SQLite commit and filesystem cleanup.
// It is deliberately retained until files, FTS shadow pages and WALs are cleaned.
export function recoverErasure(storage: Storage, finish: () => void) {
  const pending = storage.db.prepare('SELECT files FROM erasure_cleanup').get();
  if (!pending) return;
  for (const path of parse<string[]>(pending.files)) {
    const full = inside(storage.root, path);
    if (existsSync(full)) unlinkSync(full);
  }
  storage.index.exec(`DELETE FROM documents; DELETE FROM chunks; DELETE FROM vectors;
    DELETE FROM indexed; DELETE FROM file_state; DELETE FROM index_state;
    INSERT INTO documents(documents) VALUES('rebuild'); VACUUM;`);
  finish();
  for (const db of [storage.index, storage.db]) {
    db.exec('VACUUM');
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any;
    if (result.busy)
      throw new AppError(
        503,
        'Permanent deletion is waiting for an open database reader. Close other brain tools and restart Mneme.',
      );
  }
  storage.db.exec('DELETE FROM erasure_cleanup');
  storage.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

const mentions = (value: unknown, ids: Set<string>) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return [...ids].some((id) => text?.includes(id));
};
function redact(value: any, ids: Set<string>): any {
  if (typeof value === 'string') {
    if (ids.has(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, ids)).filter((v) => v !== null);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, redact(v, ids)])
        .filter(
          ([k, v]) =>
            v !== null || ['supersedes', 'memory_id', 'valid_until', 'due_at'].includes(k as string),
        ),
    );
  return value;
}

export function eraseMemory(brain: Brain, memoryId: string, check: () => void) {
  const { storage } = brain,
    { db } = storage;
  assertErasureComplete(storage);
  if (
    brain.jobs.running ||
    brain.backups.active ||
    db.prepare("SELECT 1 FROM jobs WHERE status='running'").get() ||
    db.prepare("SELECT 1 FROM ask_turns WHERE json_extract(data,'$.status')='running'").get()
  )
    throw new AppError(
      409,
      'Wait for background work, backups and Ask generation to finish before permanent deletion.',
    );
  const files = new Set<string>();
  storage.transaction(() => {
    check();
    const memory = brain.memories.get(memoryId);
    const removed = new Set([memoryId]);
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all() as any[];
    const events = rows('events');
    const tables = ['relationships', 'tasks', 'proposals', 'ask_turns', 'records'] as const;
    const all = Object.fromEntries(tables.map((table) => [table, rows(table)]));
    for (const entity of rows('entities')) if (entity.memory_id === memoryId) removed.add(entity.id);
    // Remove dependent conversations/proposals as units: their answer/body may quote erased evidence.
    let changed = true;
    while (changed) {
      const size = removed.size;
      for (const table of tables)
        for (const row of all[table]) if (mentions(row, removed)) removed.add(row.id);
      for (const event of events) if (removed.has(event.aggregate_id)) removed.add(event.id);
      changed = size !== removed.size;
    }
    const candidates = rows('sources').filter(
      (source) =>
        source.memory_id === memoryId ||
        source.name === `recovered-${memoryId}.md` ||
        events.some((e) => removed.has(e.aggregate_id) && mentions(e, new Set([source.id]))),
    );
    const retained = [
      ...rows('memories'),
      ...rows('entities'),
      ...tables.flatMap((t) => all[t]),
      ...events,
      ...rows('sources'),
      ...rows('jobs'),
    ].filter((r) => !removed.has(r.id) && !removed.has(r.aggregate_id));
    const exclusive = candidates.filter(
      (source) =>
        !retained.some(
          (r) =>
            r.id !== source.id &&
            r.aggregate_id !== source.id &&
            mentions(r, new Set([source.id, source.hash])),
        ),
    );
    const sharedHashes = new Set(
      rows('sources')
        .filter((source) => !exclusive.some((s) => s.id === source.id))
        .map((source) => source.hash),
    );
    for (const source of exclusive) {
      removed.add(source.id);
      files.add(relative(storage.root, brain.memories.objects.path(source.hash)).replaceAll('\\', '/'));
      db.prepare('INSERT OR IGNORE INTO erased_fingerprints VALUES (?,?)').run('bytes', hash(source.hash));
    }
    for (const event of events) if (removed.has(event.aggregate_id)) removed.add(event.id);
    const fingerprint = (kind: string, value: string) =>
      db.prepare('INSERT OR IGNORE INTO erased_fingerprints VALUES (?,?)').run(kind, hash(value));
    fingerprint('id', memoryId);
    fingerprint('bytes', memory.content_hash);
    for (const event of events)
      if (event.aggregate_id === memoryId) {
        const revision = parse(event.payload).memory;
        if (revision?.content_hash) fingerprint('bytes', revision.content_hash);
      }
    files.add(memory.path);
    // Include stale copies and interrupted atomic-write temporary files within the vault.
    const visit = (dir: string) => {
      for (const entry of readdirSync(inside(storage.root, dir), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) visit(path);
        else if (
          entry.isFile() &&
          (dir.startsWith('objects') || path.endsWith('.md') || path.endsWith('.tmp'))
        ) {
          const bytes = readFileSync(inside(storage.root, path));
          if (dir.startsWith('objects') && sharedHashes.has(hash(bytes))) continue;
          let id: string | undefined;
          try {
            id = readMarkdown(bytes.toString('utf8')).metadata.id;
          } catch {
            /* Match exact bytes below. */
          }
          if (
            id === memoryId ||
            erased(storage, 'bytes', hash(bytes)) ||
            (path.startsWith(memory.path + '.') && path.endsWith('.tmp')) ||
            exclusive.some(
              (s) => path.startsWith(`objects/${s.hash.slice(0, 2)}/${s.hash}.`) && path.endsWith('.tmp'),
            )
          )
            files.add(path);
        }
      }
    };
    visit('vault');
    visit('objects');
    // An explicit erasure is the sole exception to append-only history. DDL is transactional:
    // failures restore both content and the guards, and other connections never see them disabled.
    db.exec('DROP TRIGGER events_no_update; DROP TRIGGER events_no_delete;');
    for (const event of events) {
      if (removed.has(event.aggregate_id)) continue;
      if (!mentions(event, removed)) continue;
      let payload = redact(parse(event.payload), removed);
      if (payload.memory) {
        payload.memory.content_hash = hash(writeMarkdown(payload.memory));
      }
      db.prepare('UPDATE events SET payload=?,provenance=?,supersedes=? WHERE id=?').run(
        JSON.stringify(payload),
        JSON.stringify(redact(parse(event.provenance), removed)),
        removed.has(event.supersedes) ? null : event.supersedes,
        event.id,
      );
    }
    for (const event of events)
      if (removed.has(event.aggregate_id))
        db.prepare('UPDATE events SET supersedes=NULL WHERE id=?').run(event.id);
    for (const event of events)
      if (removed.has(event.aggregate_id)) db.prepare('DELETE FROM events WHERE id=?').run(event.id);
    db.exec(`CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
      CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;`);
    for (const row of all.records)
      if (removed.has(row.id)) db.prepare('UPDATE records SET supersedes=NULL WHERE id=?').run(row.id);
    for (const table of tables)
      for (const row of all[table])
        if (removed.has(row.id)) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
    for (const row of rows('jobs'))
      if (mentions(row, removed)) db.prepare('DELETE FROM jobs WHERE id=?').run(row.id);
    db.prepare('DELETE FROM outbox WHERE memory_id=?').run(memoryId);
    db.prepare('DELETE FROM entities WHERE memory_id=?').run(memoryId);
    for (const source of exclusive) db.prepare('DELETE FROM sources WHERE id=?').run(source.id);
    db.prepare('UPDATE sources SET memory_id=NULL WHERE memory_id=?').run(memoryId);
    for (const row of rows('memories')) {
      if (row.id === memoryId) continue;
      const latest = db
        .prepare(
          "SELECT payload FROM events WHERE aggregate_id=? AND kind IN ('memory.created','memory.updated','memory.archived') ORDER BY seq DESC LIMIT 1",
        )
        .get(row.id)!;
      const revised = parse(latest.payload).memory;
      const text = writeMarkdown(revised);
      if (revised.content_hash === row.content_hash) continue;
      const path = inside(storage.root, row.path);
      if (
        existsSync(path) &&
        hash(readFileSync(path)) !== row.content_hash &&
        !db.prepare('SELECT 1 FROM outbox WHERE memory_id=?').get(row.id)
      )
        throw new AppError(
          409,
          'A linked memory has external edits. Reconcile the vault and review deletion again.',
        );
      db.prepare('UPDATE memories SET supersedes=?,provenance=?,content_hash=? WHERE id=?').run(
        revised.supersedes,
        JSON.stringify(revised.provenance),
        revised.content_hash,
        row.id,
      );
      db.prepare(
        'INSERT INTO outbox VALUES (?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET content=excluded.content,previous_hash=excluded.previous_hash',
      ).run(row.id, text, row.content_hash, new Date().toISOString());
    }
    for (const row of rows('entities'))
      if (mentions(row, removed))
        db.prepare('UPDATE entities SET provenance=?,properties=? WHERE id=?').run(
          JSON.stringify(redact(parse(row.provenance), removed)),
          JSON.stringify(redact(parse(row.properties), removed)),
          row.id,
        );
    for (const row of rows('sources'))
      if (mentions(row.metadata, removed))
        db.prepare('UPDATE sources SET metadata=? WHERE id=?').run(
          JSON.stringify(redact(parse(row.metadata), removed)),
          row.id,
        );
    db.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
    // State is derived diagnostics/cursors and can contain conflict excerpts or recovery paths.
    db.exec('DELETE FROM state');
    db.prepare('INSERT INTO erasure_cleanup VALUES (1,?)').run(JSON.stringify([...files]));
  });
  try {
    recoverErasure(storage, () => {
      brain.memories.flush();
      brain.search.rebuild();
    });
  } catch {
    // The committed deletion cannot safely be undone after any file was removed.
    throw new AppError(
      503,
      'Deletion committed but cleanup is incomplete. Restart Mneme to finish it; do not restore a backup.',
    );
  } finally {
    brain.jobs.emit('change');
  }
  return { deleted: true, permanent: true };
}
