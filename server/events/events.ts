import type { Storage } from '../storage/database.js';
import type { Event, Provenance } from '../core/types.js';
import { id, now, parse } from '../core/util.js';
export class Events {
  constructor(readonly storage: Storage) {}
  append(
    kind: string,
    aggregate: string,
    payload: unknown,
    provenance: Provenance,
    supersedes: string | null = null,
  ) {
    const event = {
      id: id(),
      kind,
      aggregate_id: aggregate,
      at: now(),
      actor: provenance.actor,
      provenance,
      payload,
      supersedes,
    };
    this.storage.db
      .prepare(
        'INSERT INTO events(id,kind,aggregate_id,at,actor,provenance,payload,supersedes) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        event.id,
        kind,
        aggregate,
        event.at,
        event.actor,
        JSON.stringify(provenance),
        JSON.stringify(payload),
        supersedes,
      );
    return event;
  }
  list(
    options: { aggregate?: string; before?: string; after?: string; limit?: number; offset?: number } = {},
  ): Event[] {
    const where: string[] = [];
    const args: any[] = [];
    if (options.aggregate) {
      where.push('aggregate_id=?');
      args.push(options.aggregate);
    }
    if (options.before) {
      where.push('at<=?');
      args.push(options.before);
    }
    if (options.after) {
      where.push('at>=?');
      args.push(options.after);
    }
    return this.storage.db
      .prepare(
        `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC,seq DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(options.limit || 100, 500), options.offset || 0)
      .map((row) => ({ ...row, provenance: parse(row.provenance), payload: parse(row.payload) })) as Event[];
  }
}
