import type { Storage } from '../storage/database.js';
import type { Event, Provenance } from '../core/types.js';
import { id, now, parse } from '../core/util.js';
export class Events {
  constructor(readonly storage: Storage) {}
  timeline(options: {
    timezone: string;
    before?: string;
    after?: string;
    limit?: number;
    offset?: number;
    aggregate?: string;
    day?: string;
  }) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: options.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    this.storage.db.function('timeline_day', { deterministic: true }, (at) => {
      const parts = formatter.formatToParts(new Date(String(at)));
      const part = (type: string) => parts.find((p) => p.type === type)!.value;
      return `${part('year')}-${part('month')}-${part('day')}`;
    });
    const where: string[] = [];
    const args: any[] = [];
    if (options.before) {
      where.push('at<=?');
      args.push(options.before);
    }
    if (options.after) {
      where.push('at>=?');
      args.push(options.after);
    }
    if (options.aggregate) {
      where.push("aggregate_id=? AND kind LIKE 'memory.%' AND timeline_day(at)=?");
      args.push(options.aggregate, options.day);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = [Math.min(options.limit || 80, 100), options.offset || 0];
    const rows = options.aggregate
      ? this.storage.db
          .prepare(`SELECT * FROM events ${clause} ORDER BY at DESC,seq DESC LIMIT ? OFFSET ?`)
          .all(...args, ...page)
      : this.storage.db
          .prepare(
            `
        WITH grouped AS (
          SELECT id,at,seq,timeline_day(at) AS day,
            CASE WHEN kind LIKE 'memory.%' THEN aggregate_id ELSE id END AS group_id
          FROM events ${clause}
        ), ranked AS (
          SELECT *,count(*) OVER (PARTITION BY day,group_id) AS count,
            row_number() OVER (PARTITION BY day,group_id ORDER BY at DESC,seq DESC) AS position
          FROM grouped
        ) SELECT e.*,r.day,r.count FROM ranked r JOIN events e ON e.id=r.id
          WHERE r.position=1 ORDER BY e.at DESC,e.seq DESC LIMIT ? OFFSET ?
      `,
          )
          .all(...args, ...page);
    return rows.map((row) => ({ ...row, provenance: parse(row.provenance), payload: parse(row.payload) }));
  }
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
