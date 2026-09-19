import { z } from 'zod';
import { AppError, provenanceSchema } from '../core/types.js';
import { id, now, parse } from '../core/util.js';
import type { Storage } from '../storage/database.js';
import { Events } from '../events/events.js';
import { activeObject, archived } from './lifecycle.js';
const taskSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    status: z.enum(['open', 'doing', 'done', 'cancelled']).default('open'),
    project: z.string().max(240).default(''),
    due_at: z.string().date().nullable().default(null),
    memory_id: z.string().uuid().nullable().default(null),
    provenance: provenanceSchema.default({ kind: 'user', actor: 'user', evidence: [] }),
    expected_version: z.number().int().positive().optional(),
  })
  .strict();
const recordSchema = z
  .object({
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
    data: z.record(z.string(), z.unknown()),
    provenance: provenanceSchema.default({ kind: 'user', actor: 'user', evidence: [] }),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().nullable().default(null),
    supersedes: z.string().uuid().nullable().default(null),
  })
  .strict();
export class Structured {
  readonly events: Events;
  constructor(readonly storage: Storage) {
    this.events = new Events(storage);
  }
  tasks(options: { status?: string; project?: string; limit?: number; offset?: number } = {}) {
    const conditions: string[] = [activeObject('task', 'tasks.id')],
      args: any[] = [];
    if (options.status) {
      conditions.push('status=?');
      args.push(options.status);
    }
    if (options.project) {
      conditions.push('project=?');
      args.push(options.project);
    }
    return this.storage.db
      .prepare(
        `SELECT * FROM tasks ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,due_at IS NULL,due_at,created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(options.limit || 200, 500), options.offset || 0)
      .map((row) => ({ ...row, provenance: parse(row.provenance) }));
  }
  task(input: unknown, taskId?: string) {
    const { expected_version, ...data } = taskSchema.parse(input);
    const old = taskId
      ? (this.storage.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as any)
      : null;
    if (taskId && !old) throw new AppError(404, 'Task not found');
    if (taskId && archived(this.storage, 'task', taskId)) throw new AppError(409, 'This task was deleted');
    if (old && expected_version !== old.version)
      throw new AppError(409, 'Task changed; reload before saving');
    const task = {
      ...data,
      id: old?.id || id(),
      created_at: old?.created_at || now(),
      updated_at: now(),
      version: (old?.version || 0) + 1,
    };
    this.storage.transaction(() => {
      if (taskId && archived(this.storage, 'task', taskId)) throw new AppError(409, 'This task was deleted');
      if (
        old &&
        this.storage.db.prepare('SELECT version FROM tasks WHERE id=?').get(old.id)!.version !== old.version
      )
        throw new AppError(409, 'Concurrent task edit');
      this.storage.db
        .prepare(
          'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,project=excluded.project,due_at=excluded.due_at,memory_id=excluded.memory_id,provenance=excluded.provenance,updated_at=excluded.updated_at,version=excluded.version',
        )
        .run(
          task.id,
          task.title,
          task.status,
          task.project,
          task.due_at,
          task.memory_id,
          JSON.stringify(task.provenance),
          task.created_at,
          task.updated_at,
          task.version,
        );
      this.events.append(old ? 'task.updated' : 'task.created', task.id, { task }, task.provenance);
    });
    return task;
  }
  record(input: unknown) {
    const data = recordSchema.parse(input);
    if (JSON.stringify(data.data).length > 100000) throw new AppError(400, 'Record too large');
    const record = { ...data, id: id(), valid_from: data.valid_from || now(), created_at: now() };
    if (record.valid_until && record.valid_until <= record.valid_from)
      throw new AppError(400, 'Invalid validity interval');
    this.storage.transaction(() => {
      this.storage.db
        .prepare('INSERT INTO records VALUES (?,?,?,?,?,?,?,?)')
        .run(
          record.id,
          record.type,
          JSON.stringify(record.data),
          JSON.stringify(record.provenance),
          record.valid_from,
          record.valid_until,
          record.supersedes,
          record.created_at,
        );
      this.events.append('record.created', record.id, { record }, record.provenance);
    });
    return record;
  }
  records(type?: string, limit = 100, offset = 0) {
    return this.storage.db
      .prepare(
        `SELECT * FROM records WHERE ${activeObject('record', 'records.id')} ${type ? 'AND type=?' : ''} ORDER BY valid_from DESC LIMIT ? OFFSET ?`,
      )
      .all(...(type ? [type] : []), Math.min(limit, 500), offset)
      .map((row) => ({ ...row, data: parse(row.data), provenance: parse(row.provenance) }));
  }
}
