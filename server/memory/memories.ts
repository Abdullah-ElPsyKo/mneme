import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { relative } from 'node:path';
import {
  memorySchema,
  projectState,
  AppError,
  type Memory,
  type MemoryInput,
  type Provenance,
} from '../core/types.js';
import { atomicWrite, hash, id, inside, now, parse } from '../core/util.js';
import type { Storage } from '../storage/database.js';
import { Events } from '../events/events.js';
import { Objects } from '../ingestion/objects.js';
import { importedFields, readMarkdown, writeMarkdown } from './markdown.js';
import { retireReferences } from './lifecycle.js';
import { erased, assertErasureComplete } from './erasure.js';

export class Memories {
  readonly events: Events;
  readonly objects: Objects;
  onChange?: (memoryId: string) => void;
  constructor(readonly storage: Storage) {
    this.events = new Events(storage);
    this.objects = new Objects(storage);
  }
  decode(row: any, body = ''): Memory {
    return {
      ...row,
      facts: parse(row.facts),
      tags: parse(row.tags),
      provenance: parse(row.provenance),
      private: !!row.private,
      project_state: projectState(row),
      body,
    };
  }
  get(memoryId: string, at?: string): Memory {
    if (at) {
      const event = this.storage.db
        .prepare(
          "SELECT payload FROM events WHERE aggregate_id=? AND kind IN ('memory.created','memory.updated','memory.archived') AND at<=? ORDER BY at DESC,seq DESC LIMIT 1",
        )
        .get(memoryId, at);
      if (!event) throw new AppError(404, 'Memory did not exist at this time');
      return this.normalize(parse(event.payload).memory);
    }
    const row = this.storage.db.prepare('SELECT * FROM memories WHERE id=?').get(memoryId) as any;
    if (!row) throw new AppError(404, 'Memory not found');
    const pending = this.storage.db.prepare('SELECT content FROM outbox WHERE memory_id=?').get(memoryId);
    let text: string;
    if (pending) text = String(pending.content);
    else {
      const path = inside(this.storage.root, row.path);
      if (!existsSync(path)) {
        const latest = this.storage.db
          .prepare(
            "SELECT payload FROM events WHERE aggregate_id=? AND kind LIKE 'memory.%' ORDER BY seq DESC LIMIT 1",
          )
          .get(memoryId);
        if (!latest) throw new AppError(500, 'Missing canonical memory and recovery history');
        return this.normalize({ ...parse(latest.payload).memory, project_state: row.project_state });
      }
      text = readFileSync(path, 'utf8');
      if (hash(text) !== row.content_hash) {
        // Preserve the committed version until the watcher has validated the external edit.
        const latest = this.storage.db
          .prepare(
            "SELECT payload FROM events WHERE aggregate_id=? AND kind IN ('memory.created','memory.updated','memory.archived') ORDER BY seq DESC LIMIT 1",
          )
          .get(memoryId);
        if (latest)
          return this.normalize({ ...parse(latest.payload).memory, project_state: row.project_state });
      }
    }
    return this.decode(row, readMarkdown(text).body);
  }
  normalize(memory: Memory): Memory {
    return {
      ...memory,
      project_state: projectState(memory),
      facts: memory.facts ?? (memory.fact_key ? [{ key: memory.fact_key, value: memory.fact_value }] : []),
    };
  }
  list(
    options: {
      type?: string;
      status?: string;
      project?: string;
      project_state?: string;
      memory_class?: string;
      tag?: string;
      q?: string;
      limit?: number;
      offset?: number;
      includeArchived?: boolean;
    } = {},
  ): Memory[] {
    const where: string[] = [],
      args: any[] = [];
    if (options.type) {
      where.push('type=?');
      args.push(options.type);
    }
    if (options.project_state) {
      where.push("type='project' AND project_state=?");
      args.push(options.project_state);
    }
    if (options.status) {
      where.push('status=?');
      args.push(options.status);
    } else if (!options.includeArchived) where.push("status!='archived'");
    if (options.project) {
      where.push("(project=? COLLATE NOCASE OR (type='project' AND title=? COLLATE NOCASE))");
      args.push(options.project, options.project);
    }
    if (options.memory_class) {
      where.push('memory_class=?');
      args.push(options.memory_class);
    }
    if (options.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value=? COLLATE NOCASE)');
      args.push(options.tag);
    }
    if (options.q) {
      where.push("title LIKE ? ESCAPE '\\'");
      args.push('%' + options.q.replace(/[\\%_]/g, '\\$&') + '%');
    }
    return this.storage.db
      .prepare(
        `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(options.limit || 100, 500), options.offset || 0)
      .map((row) => this.decode(row));
  }
  save(input: MemoryInput, memoryId?: string, externalPath?: string, check?: () => void): Memory {
    assertErasureComplete(this.storage);
    const validated = memorySchema.parse(input);
    const { expected_version, ...data } = validated;
    const old = memoryId ? this.get(memoryId) : null;
    if (old && expected_version !== old.version)
      throw new AppError(
        409,
        'This memory changed. Reload it before saving. Your edit has not been discarded.',
      );
    if (old && !externalPath) {
      const currentPath = inside(this.storage.root, old.path);
      if (
        existsSync(currentPath) &&
        hash(readFileSync(currentPath)) !== old.content_hash &&
        !this.storage.db.prepare('SELECT 1 FROM outbox WHERE memory_id=?').get(old.id)
      )
        throw new AppError(
          409,
          'This Markdown file was edited externally. Reconcile the vault before saving.',
        );
    }
    const timestamp = now();
    const memory: Memory = {
      ...data,
      project_state:
        data.type === 'project'
          ? (data.project_state ??
            (old?.type === 'project'
              ? projectState(old)
              : data.status === 'completed'
                ? 'completed'
                : 'planned'))
          : null,
      id: old?.id || id(),
      created_at: old?.created_at || timestamp,
      updated_at: timestamp,
      version: (old?.version || 0) + 1,
      path: old?.path || externalPath || '',
      content_hash: '',
      valid_from: data.valid_from || old?.valid_from || timestamp,
    };
    memory.path ||= `vault/${memory.id}.md`;
    inside(this.storage.root, memory.path);
    if (memory.valid_until && memory.valid_until <= memory.valid_from!)
      throw new AppError(400, 'valid_until must follow valid_from');
    if (memory.supersedes) {
      if (memory.supersedes === memory.id) throw new AppError(400, 'A memory cannot supersede itself');
      const previous = this.get(memory.supersedes);
      let cursor: Memory | null = previous;
      const seen = new Set([memory.id]);
      while (cursor) {
        if (seen.has(cursor.id)) throw new AppError(400, 'Supersession cycle');
        seen.add(cursor.id);
        cursor = cursor.supersedes ? this.get(cursor.supersedes) : null;
      }
    }
    const text = writeMarkdown(memory);
    memory.content_hash = hash(text);
    this.storage.transaction(() => {
      check?.();
      if (old) {
        const current = this.storage.db.prepare('SELECT version FROM memories WHERE id=?').get(old.id) as any;
        if (current.version !== old.version) throw new AppError(409, 'Concurrent memory edit');
      }
      const previous = this.storage.db
        .prepare('SELECT id FROM events WHERE aggregate_id=? ORDER BY seq DESC LIMIT 1')
        .get(memory.id);
      this.events.append(
        old ? (memory.status === 'archived' ? 'memory.archived' : 'memory.updated') : 'memory.created',
        memory.id,
        { memory },
        memory.provenance,
        previous ? String(previous.id) : null,
      );
      const columns = [
        'id',
        'title',
        'type',
        'memory_class',
        'status',
        'project_state',
        'project',
        'tags',
        'importance',
        'private',
        'created_at',
        'updated_at',
        'valid_from',
        'valid_until',
        'supersedes',
        'fact_key',
        'fact_value',
        'facts',
        'provenance',
        'version',
        'path',
        'content_hash',
      ];
      const values = columns.map((column) =>
        column === 'private'
          ? Number(memory.private)
          : column === 'tags' || column === 'provenance' || column === 'facts'
            ? JSON.stringify((memory as any)[column])
            : (memory as any)[column],
      );
      this.storage.db
        .prepare(
          `INSERT INTO memories(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${columns
            .filter((c) => c !== 'id')
            .map((c) => `${c}=excluded.${c}`)
            .join(',')}`,
        )
        .run(...values);
      const previousHash =
        externalPath && existsSync(inside(this.storage.root, memory.path))
          ? hash(readFileSync(inside(this.storage.root, memory.path)))
          : old?.content_hash || null;
      this.storage.db
        .prepare(
          'INSERT INTO outbox VALUES (?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET content=excluded.content,previous_hash=excluded.previous_hash,created_at=excluded.created_at',
        )
        .run(memory.id, text, previousHash, timestamp);
      this.storage.db
        .prepare(
          `INSERT INTO entities(id,name,type,memory_id,properties,provenance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,provenance=excluded.provenance,updated_at=excluded.updated_at`,
        )
        .run(
          memory.id,
          memory.title,
          memory.type,
          memory.id,
          '{}',
          JSON.stringify(memory.provenance),
          memory.created_at,
          timestamp,
        );
      if (memory.status === 'archived') retireReferences(this.storage, memory.id);
    });
    this.flush(memory.id);
    this.onChange?.(memory.id);
    return memory;
  }
  flush(memoryId?: string) {
    const pending = this.storage.db
      .prepare(
        `SELECT o.*,m.path FROM outbox o JOIN memories m ON m.id=o.memory_id ${memoryId ? 'WHERE memory_id=?' : ''}`,
      )
      .all(...(memoryId ? [memoryId] : []));
    for (const entry of pending as any[]) {
      const path = inside(this.storage.root, entry.path),
        wanted = hash(entry.content);
      if (existsSync(path)) {
        const bytes = readFileSync(path),
          existingHash = hash(bytes);
        if (existingHash !== wanted && existingHash !== entry.previous_hash) {
          const source = this.objects.put(`recovered-${entry.memory_id}.md`, bytes, 'text/markdown', {
            recovery: true,
          });
          this.events.append(
            'recovery.external_conflict',
            entry.memory_id,
            {
              source_id: source.id,
              message: 'External file preserved before replaying a committed revision',
            },
            { kind: 'software', actor: 'recovery', evidence: [source.id] },
          );
        }
      }
      atomicWrite(path, entry.content);
      this.storage.db
        .prepare('DELETE FROM outbox WHERE memory_id=? AND content=?')
        .run(entry.memory_id, entry.content);
      try {
        const stat = statSync(path);
        this.storage.index
          .prepare(
            'INSERT INTO file_state VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,hash=excluded.hash',
          )
          .run(entry.path, stat.size, stat.mtimeMs, wanted);
      } catch {
        /* Derived stat cache can be reconstructed; the canonical write already succeeded. */
      }
    }
  }
  reconcileFile(path: string, forceHash = false) {
    assertErasureComplete(this.storage);
    const fullPath = inside(this.storage.root, path);
    const rel = relative(this.storage.root, fullPath).replaceAll('\\', '/');
    if (!rel.startsWith('vault/') || !rel.endsWith('.md')) return;
    const row = this.storage.db.prepare('SELECT * FROM memories WHERE path=?').get(rel) as any;
    if (!existsSync(fullPath)) {
      if (row && row.status !== 'archived') {
        const old = this.get(row.id);
        this.save(
          {
            ...this.input(old),
            status: 'archived',
            provenance: {
              kind: 'observation',
              actor: 'filesystem',
              extraction_method: 'external-deletion',
              evidence: [],
            },
          },
          row.id,
          rel,
        );
      }
      return;
    }
    const stat = statSync(fullPath);
    const indexedStat = this.storage.index.prepare('SELECT * FROM file_state WHERE path=?').get(rel);
    if (
      !forceHash &&
      row &&
      indexedStat &&
      indexedStat.size === stat.size &&
      indexedStat.mtime === stat.mtimeMs &&
      indexedStat.hash === row.content_hash
    )
      return;
    const bytes = readFileSync(fullPath);
    if (row && hash(bytes) === row.content_hash) {
      this.storage.index
        .prepare(
          'INSERT INTO file_state VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,hash=excluded.hash',
        )
        .run(rel, stat.size, stat.mtimeMs, row.content_hash);
      return;
    }
    if (bytes.length > 2_000_000) throw new AppError(413, 'Markdown exceeds 2 MB');
    const { metadata, body } = readMarkdown(bytes.toString('utf8'));
    if (
      (metadata.id && erased(this.storage, 'id', String(metadata.id))) ||
      erased(this.storage, 'bytes', hash(bytes))
    ) {
      unlinkSync(fullPath);
      return;
    }
    const source = this.objects.put(rel, bytes, 'text/markdown', { external_edit: true });
    const existing = row ? this.get(row.id) : null;
    const memory = this.save(
      {
        ...(existing ? this.input(existing) : {}),
        ...importedFields(metadata),
        ...(existing?.status === 'archived' ? { status: 'archived' as const } : {}),
        title: metadata.title || existing?.title || body.match(/^#\s+(.+)$/m)?.[1] || rel.split('/').pop()!,
        body,
        provenance: {
          kind: 'observation',
          actor: 'filesystem',
          source_id: source.id,
          source_location: rel,
          extraction_method: 'markdown',
          evidence: [source.id],
        },
      },
      row?.id,
      rel,
    );
    this.storage.db.prepare('UPDATE sources SET memory_id=? WHERE id=?').run(memory.id, source.id);
    return memory;
  }
  reconcile(forceHash = false) {
    this.flush();
    let count = 0;
    const errors: { path: string; error: string }[] = [];
    const visit = (dir: string) => {
      for (const entry of readdirSync(inside(this.storage.root, dir), { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          errors.push({ path: `${dir}/${entry.name}`, error: 'Symbolic link ignored' });
          continue;
        }
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith('.md'))
          try {
            if (this.reconcileFile(path, forceHash)) count++;
          } catch (error) {
            errors.push({ path, error: (error as Error).message });
          }
      }
    };
    visit('vault');
    for (const row of this.storage.db.prepare("SELECT path FROM memories WHERE status!='archived'").all())
      if (!existsSync(inside(this.storage.root, String(row.path))))
        try {
          this.reconcileFile(String(row.path));
        } catch (error) {
          errors.push({ path: String(row.path), error: (error as Error).message });
        }
    this.storage.state('reconciliation', { at: now(), count, errors });
    return { count, errors };
  }
  input(memory: Memory): MemoryInput {
    const { id, version, path, content_hash, created_at, updated_at, ...input } = memory;
    return { ...input, expected_version: version };
  }
}
