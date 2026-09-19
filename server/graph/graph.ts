import { z } from 'zod';
import { AppError, provenanceSchema, type Entity, type Relationship } from '../core/types.js';
import { id, now, parse } from '../core/util.js';
import type { Storage } from '../storage/database.js';
import { Events } from '../events/events.js';
import { activeObject, archived, endRelationship } from '../memory/lifecycle.js';
const entitySchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    properties: z.record(z.string(), z.unknown()).default({}),
    provenance: provenanceSchema.default({ kind: 'user', actor: 'user', evidence: [] }),
  })
  .strict();
const relationSchema = z
  .object({
    from_id: z.string().uuid(),
    to_id: z.string().uuid(),
    type: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
    provenance: provenanceSchema.default({ kind: 'user', actor: 'user', evidence: [] }),
  })
  .strict();
export class Graph {
  readonly events: Events;
  constructor(readonly storage: Storage) {
    this.events = new Events(storage);
  }
  entity(input: unknown) {
    const data = entitySchema.parse(input);
    const entity: Entity = { ...data, id: id(), memory_id: null, created_at: now(), updated_at: now() };
    if (JSON.stringify(data.properties).length > 100000)
      throw new AppError(400, 'Entity properties too large');
    this.storage.transaction(() => {
      this.storage.db
        .prepare('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?)')
        .run(
          entity.id,
          entity.name,
          entity.type,
          null,
          JSON.stringify(entity.properties),
          JSON.stringify(entity.provenance),
          entity.created_at,
          entity.updated_at,
        );
      this.events.append('entity.created', entity.id, { entity }, entity.provenance);
    });
    return entity;
  }
  link(input: unknown) {
    const data = relationSchema.parse(input);
    if (data.from_id === data.to_id) throw new AppError(400, 'Self relationships are not supported');
    for (const endpoint of [data.from_id, data.to_id])
      if (
        !this.storage.db
          .prepare(
            `SELECT id FROM entities WHERE id=? AND ${activeObject('entity', 'entities.id')} AND (memory_id IS NULL OR memory_id IN (SELECT id FROM memories WHERE status!='archived'))`,
          )
          .get(endpoint)
      )
        throw new AppError(404, 'Relationship endpoint not found');
    const old = this.storage.db
      .prepare('SELECT * FROM relationships WHERE from_id=? AND to_id=? AND type=? AND valid_until IS NULL')
      .get(data.from_id, data.to_id, data.type);
    if (old) return { ...old, provenance: parse(old.provenance) } as Relationship;
    const relationship: Relationship = {
      ...data,
      id: id(),
      created_at: now(),
      valid_from: now(),
      valid_until: null,
    };
    this.storage.transaction(() => {
      for (const endpoint of [data.from_id, data.to_id])
        if (
          !this.storage.db
            .prepare(
              `SELECT id FROM entities WHERE id=? AND ${activeObject('entity', 'entities.id')} AND (memory_id IS NULL OR memory_id IN (SELECT id FROM memories WHERE status!='archived'))`,
            )
            .get(endpoint)
        )
          throw new AppError(409, 'Relationship endpoint was deleted');
      this.storage.db
        .prepare('INSERT INTO relationships VALUES (?,?,?,?,?,?,?,?)')
        .run(
          relationship.id,
          data.from_id,
          data.to_id,
          data.type,
          JSON.stringify(data.provenance),
          relationship.created_at,
          relationship.valid_from,
          null,
        );
      this.events.append('relationship.created', relationship.id, { relationship }, data.provenance);
    });
    return relationship;
  }
  unlink(relationshipId: string) {
    const row = this.storage.db.prepare('SELECT * FROM relationships WHERE id=?').get(relationshipId) as any;
    if (!row) throw new AppError(404, 'Relationship not found');
    if (row.valid_until) return;
    this.storage.transaction(() => endRelationship(this.storage, relationshipId));
  }
  inspect(entityId: string) {
    const row = this.storage.db.prepare('SELECT * FROM entities WHERE id=?').get(entityId);
    if (!row) throw new AppError(404, 'Entity not found');
    const relationships = this.storage.db
      .prepare(
        'SELECT r.*,a.name AS from_name,b.name AS to_name FROM relationships r JOIN entities a ON a.id=r.from_id JOIN entities b ON b.id=r.to_id WHERE r.from_id=? OR r.to_id=? ORDER BY r.created_at DESC',
      )
      .all(entityId, entityId)
      .map((row) => ({ ...row, provenance: parse(row.provenance) }));
    return {
      entity: {
        ...row,
        status: archived(this.storage, 'entity', entityId) ? 'archived' : 'active',
        provenance: parse(row.provenance),
        properties: parse(row.properties),
      },
      relationships,
    };
  }
  view(options: { focus?: string; type?: string; at?: string; limit?: number; offset?: number } = {}) {
    const cap = Math.min(options.limit || 350, 800);
    let entities: any[];
    let relationships: any[];
    let total: number;
    if (options.at) {
      // Historical memory/standalone-entity snapshots, one current revision per aggregate at the selected time.
      const rows = this.storage.db
        .prepare(
          `SELECT e.kind,e.payload FROM events e JOIN (SELECT aggregate_id,max(seq) AS seq FROM events WHERE at<=? AND kind IN ('memory.created','memory.updated','memory.archived','entity.created','entity.archived') GROUP BY aggregate_id) latest ON latest.seq=e.seq`,
        )
        .all(options.at);
      entities = rows
        .map((row) => {
          const p = parse(row.payload);
          const m = p.memory;
          return m
            ? {
                id: m.id,
                name: m.title,
                type: m.type,
                memory_id: m.id,
                status: m.status,
                provenance: m.provenance,
                created_at: m.created_at,
                updated_at: m.updated_at,
              }
            : p.entity;
        })
        .filter((e) => e.status !== 'archived');
      total = entities.length;
      entities = entities
        .filter((e) => !options.type || e.type === options.type)
        .slice(options.offset || 0, (options.offset || 0) + cap);
      relationships = this.storage.db
        .prepare('SELECT * FROM relationships WHERE valid_from<=? AND (valid_until IS NULL OR valid_until>?)')
        .all(options.at, options.at);
    } else {
      const active = `(m.id IS NULL OR m.status!='archived') AND ${activeObject('entity', 'e.id')}`;
      total = Number(
        this.storage.db
          .prepare(
            `SELECT count(*) AS n FROM entities e LEFT JOIN memories m ON m.id=e.memory_id WHERE ${active}`,
          )
          .get()!.n,
      );
      const condition = options.focus
        ? 'AND (e.id=? OR e.id IN (SELECT to_id FROM relationships WHERE from_id=? AND valid_until IS NULL) OR e.id IN (SELECT from_id FROM relationships WHERE to_id=? AND valid_until IS NULL))'
        : options.type
          ? 'AND e.type=?'
          : '';
      const args = options.focus
        ? [options.focus, options.focus, options.focus]
        : options.type
          ? [options.type]
          : [];
      entities = this.storage.db
        .prepare(
          `SELECT e.*,m.status,m.importance FROM entities e LEFT JOIN memories m ON m.id=e.memory_id WHERE ${active} ${condition} ORDER BY coalesce(m.importance,0.5) DESC,e.id LIMIT ? OFFSET ?`,
        )
        .all(...args, cap, options.offset || 0)
        .map((row) => ({ ...row, provenance: parse(row.provenance), properties: parse(row.properties) }));
      const ids = entities.map((e) => e.id);
      relationships = ids.length
        ? this.storage.db
            .prepare(
              `SELECT * FROM relationships WHERE valid_until IS NULL AND from_id IN (${ids.map(() => '?').join(',')}) AND to_id IN (${ids.map(() => '?').join(',')})`,
            )
            .all(...ids, ...ids)
        : [];
    }
    const included = new Set(entities.map((e) => e.id));
    relationships = relationships
      .filter((r) => included.has(r.from_id) && included.has(r.to_id))
      .map((row) => ({ ...row, provenance: parse(row.provenance) }));
    const clusters = options.at
      ? Object.entries(
          entities.reduce(
            (acc, e) => {
              acc[e.type] = (acc[e.type] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          ),
        ).map(([type, count]) => ({ type, count }))
      : this.storage.db
          .prepare(
            `SELECT e.type,count(*) AS count FROM entities e LEFT JOIN memories m ON m.id=e.memory_id WHERE (m.id IS NULL OR m.status!='archived') AND ${activeObject('entity', 'e.id')} GROUP BY e.type ORDER BY count DESC`,
          )
          .all();
    return {
      entities,
      relationships,
      clusters,
      total,
      truncated: total > entities.length,
      at: options.at || null,
    };
  }
}
