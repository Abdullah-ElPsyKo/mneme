import { AppError, type Memory, type SearchHit } from '../core/types.js';
import { cosine, hash, now, parse } from '../core/util.js';
import type { Memories } from '../memory/memories.js';
import { activeObject } from '../memory/lifecycle.js';
import { askIntent, factText, queryVariants } from './evidence.js';

export type ParsedQuery = {
  text: string;
  phrases: string[];
  filters: Record<string, string>;
  terms: string[];
};
export function parseQuery(query: string): ParsedQuery {
  if (query.length > 2000) throw new AppError(400, 'Search query exceeds 2,000 characters');
  const filters: Record<string, string> = {},
    phrases: string[] = [],
    free: string[] = [];
  const parts = query.match(/(?:[\w_-]+:)?"[^"]*"|\S+/g) || [];
  for (const part of parts) {
    const filter = part.match(/^(type|project|tag|source|before|after|class|status|entity):(.+)$/);
    if (filter) {
      filters[filter[1]] = filter[2].replace(/^"|"$/g, '');
      continue;
    }
    if (part.startsWith('"') && part.endsWith('"')) phrases.push(part.slice(1, -1));
    else free.push(part);
  }
  for (const key of ['before', 'after'])
    if (
      filters[key] &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(filters[key]) || !Number.isFinite(Date.parse(filters[key])))
    )
      throw new AppError(400, `${key}: expects YYYY-MM-DD`);
  const text = [...free, ...phrases].join(' ').trim();
  return { text, phrases, filters, terms: text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [] };
}
export class Search {
  constructor(readonly memories: Memories) {}
  index(memoryId: string) {
    const m = this.memories.get(memoryId),
      db = this.memories.storage.index;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM documents WHERE id=?').run(m.id);
      db.prepare('DELETE FROM chunks WHERE memory_id=?').run(m.id);
      if (m.status !== 'archived')
        db.prepare('INSERT INTO documents(id,title,body,tags,project,facts) VALUES (?,?,?,?,?,?)').run(
          m.id,
          m.title,
          m.body,
          m.tags.join(' '),
          m.project,
          factText(m),
        );
      const paragraphs =
        m.status === 'archived' ? [] : m.body.match(/[\s\S]{1,1800}(?:\n|$)/g) || (m.body ? [m.body] : []);
      paragraphs.forEach((text, position) =>
        db
          .prepare('INSERT INTO chunks VALUES (?,?,?,?,?)')
          .run(`${m.id}:${position}`, m.id, position, text, hash(text)),
      );
      db.prepare('INSERT INTO indexed VALUES (?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash').run(
        m.id,
        m.content_hash,
      );
      db.prepare('DELETE FROM vectors WHERE memory_id=? AND hash!=?').run(m.id, m.content_hash);
      if (m.status === 'archived') db.prepare('DELETE FROM vectors WHERE memory_id=?').run(m.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  rebuild() {
    const db = this.memories.storage.index;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM documents; DELETE FROM indexed; DELETE FROM chunks; DELETE FROM vectors;');
      const document = db.prepare('INSERT INTO documents VALUES (?,?,?,?,?,?)');
      const indexed = db.prepare('INSERT INTO indexed VALUES (?,?)');
      const chunk = db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?)');
      let count = 0;
      for (const row of this.memories.storage.db.prepare('SELECT id FROM memories ORDER BY id').iterate()) {
        const m = this.memories.get(String(row.id));
        indexed.run(m.id, m.content_hash);
        count++;
        if (m.status === 'archived') continue;
        document.run(m.id, m.title, m.body, m.tags.join(' '), m.project, factText(m));
        for (let start = 0, position = 0; start < m.body.length; start += 1800, position++) {
          const text = m.body.slice(start, start + 1800);
          chunk.run(`${m.id}:${position}`, m.id, position, text, hash(text));
        }
      }
      db.prepare(
        "INSERT INTO index_state VALUES ('last_rebuild',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(now());
      db.exec('COMMIT');
      return { count };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  syncMissing() {
    // Repair derived state after an interrupted archive or an older app build.
    this.memories.storage.index.exec(`
      DELETE FROM documents WHERE id IN (SELECT id FROM canonical.memories WHERE status='archived');
      DELETE FROM chunks WHERE memory_id IN (SELECT id FROM canonical.memories WHERE status='archived');
      DELETE FROM vectors WHERE memory_id IN (SELECT id FROM canonical.memories WHERE status='archived');`);
    const hashes = new Map(
      this.memories.storage.index
        .prepare('SELECT id,hash FROM indexed')
        .all()
        .map((r) => [r.id, r.hash]),
    );
    let count = 0;
    for (const row of this.memories.storage.db.prepare('SELECT id,content_hash FROM memories').iterate())
      if (hashes.get(row.id) !== row.content_hash) {
        this.index(String(row.id));
        count++;
      }
    return count;
  }
  storeVector(memory: Memory, vector: number[], provider: string) {
    // The model call is asynchronous. Recheck canonical status and revision in
    // the same SQL statement that publishes its result after it completes.
    this.memories.storage.index
      .prepare(
        `INSERT INTO vectors (memory_id,hash,provider,vector)
      SELECT id,content_hash,?,? FROM canonical.memories WHERE id=? AND content_hash=? AND status!='archived' AND private=0
      ON CONFLICT(memory_id) DO UPDATE SET hash=excluded.hash,provider=excluded.provider,vector=excluded.vector`,
      )
      .run(provider, JSON.stringify(vector), memory.id, memory.content_hash);
  }
  query(
    query: string,
    options: {
      limit?: number;
      offset?: number;
      vector?: number[];
      provider?: string;
      includePrivate?: boolean;
      at?: string;
      ask?: boolean;
    } = {},
  ): SearchHit[] {
    const q = parseQuery(query),
      { storage } = this.memories,
      ranked = new Map<string, { score: number; signals: Set<string>; entities: Set<string> }>();
    const similarities = new Map<string, number>();
    const graphLinks = new Map<string, NonNullable<SearchHit['graph_links']>>();
    const add = (memoryId: string, rank: number, weight: number, channel: string, entity?: string) => {
      const result = ranked.get(memoryId) || {
        score: 0,
        signals: new Set<string>(),
        entities: new Set<string>(),
      };
      result.score += weight / (60 + rank);
      result.signals.add(channel);
      if (entity) result.entities.add(entity);
      ranked.set(memoryId, result);
    };
    const candidateCap = 1500;
    const where: string[] = [],
      values: any[] = [];
    if (q.filters.type) {
      where.push('m.type=?');
      values.push(q.filters.type);
    }
    if (q.filters.project) {
      where.push("(m.project=? COLLATE NOCASE OR (m.type='project' AND m.title=? COLLATE NOCASE))");
      values.push(q.filters.project, q.filters.project);
    }
    if (q.filters.class) {
      where.push('m.memory_class=?');
      values.push(q.filters.class);
    }
    if (q.filters.tag) {
      where.push('EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value=? COLLATE NOCASE)');
      values.push(q.filters.tag);
    }
    if (q.filters.source) {
      where.push(
        "(json_extract(m.provenance,'$.source_id')=? OR EXISTS(SELECT 1 FROM sources s WHERE s.memory_id=m.id AND s.name LIKE ? ESCAPE '\\'))",
      );
      values.push(q.filters.source, '%' + q.filters.source.replace(/[\\%_]/g, '\\$&') + '%');
    }
    if (q.filters.before) {
      where.push('m.updated_at<?');
      values.push(q.filters.before + 'T00:00:00.000Z');
    }
    if (q.filters.after) {
      where.push('m.updated_at>=?');
      values.push(q.filters.after + 'T00:00:00.000Z');
    }
    if (q.filters.status) {
      where.push('m.status=?');
      values.push(q.filters.status);
    } else where.push("m.status!='archived'");
    if (options.includePrivate === false) where.push('m.private=0');
    const eligibility = `SELECT m.id FROM memories m WHERE ${where.join(' AND ')}`;
    const eligible =
      where.length > 1 || options.includePrivate === false
        ? new Set(
            storage.db
              .prepare(eligibility)
              .all(...values)
              .map((r) => String(r.id)),
          )
        : null;
    const eligibleId = (value: string) => !eligible || eligible.has(value);
    if (q.text || q.filters.entity) {
      const terms = [
        ...new Set([
          ...(q.text.match(/[\p{L}\p{N}_]+/gu) || []),
          ...(options.ask ? queryVariants(query) : []),
        ]),
      ];
      const escape = (v: string) => '"' + v.replaceAll('"', '""') + '"';
      const match = q.phrases.length
        ? q.phrases.map(escape).join(' AND ') +
          (terms.length ? ' AND (' + terms.map(escape).join(' OR ') + ')' : '')
        : terms.map(escape).join(' OR ');
      if (match) {
        const rows = storage.index
          .prepare(
            `SELECT d.id,bm25(documents,0,8,1,3,4,6) AS rank FROM documents d JOIN canonical.memories m ON m.id=d.id WHERE documents MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
          )
          .all(match, ...values, candidateCap);
        rows.forEach((row, i) => {
          if (eligibleId(String(row.id))) add(String(row.id), i + 1, 1, 'full-text');
        });
      }
      const entityText = (q.filters.entity || q.text)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .trim();
      const words = q.terms.slice(0, 40);
      const entityRows = storage.db
        .prepare(
          `SELECT * FROM entities WHERE ${activeObject('entity', 'entities.id')} AND (lower(name)=? ${words.length ? 'OR lower(name) IN (' + words.map(() => '?').join(',') + ')' : ''} OR instr(' '||?||' ',' '||lower(name)||' ')>0 OR memory_id IN (SELECT id FROM memories WHERE type='project' AND project!='' AND instr(' '||?||' ',' '||lower(project)||' ')>0)) LIMIT 80`,
        )
        .all(entityText, ...words, entityText, entityText);
      entityRows.forEach((row, rank) => {
        const eid = String(row.id);
        if (row.memory_id && !eligibleId(String(row.memory_id))) return;
        if (row.memory_id && eligibleId(String(row.memory_id)))
          add(String(row.memory_id), rank + 1, 1.4, 'entity', eid);
        const neighbors = storage.db
          .prepare(
            'SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS id,from_id,to_id,id AS relationship_id,type FROM relationships WHERE (from_id=? OR to_id=?) AND valid_until IS NULL LIMIT 200',
          )
          .all(eid, eid, eid);
        neighbors.forEach((neighbor, i) => {
          if (eligibleId(String(neighbor.id))) {
            const neighborId = String(neighbor.id);
            add(neighborId, i + 1, 0.65, 'graph', eid);
            const name = String(
              storage.db.prepare('SELECT name FROM entities WHERE id=?').get(neighborId)?.name || '',
            );
            const link = {
              id: String(neighbor.relationship_id),
              from_id: String(neighbor.from_id),
              to_id: String(neighbor.to_id),
              from: neighbor.from_id === eid ? String(row.name) : name,
              to: neighbor.from_id === eid ? name : String(row.name),
              relationship: String(neighbor.type),
            };
            graphLinks.set(neighborId, [...(graphLinks.get(neighborId) || []), link]);
          }
        });
      });
      if (options.vector?.length && options.provider) {
        const candidates = storage.index
          .prepare(
            'SELECT v.* FROM vectors v JOIN canonical.memories m ON m.id=v.memory_id AND m.content_hash=v.hash WHERE v.provider=? LIMIT 20000',
          )
          .all(options.provider)
          .map((row) => ({
            id: String(row.memory_id),
            similarity: cosine(options.vector!, parse(row.vector)),
          }))
          .filter((r) => r.similarity > 0.15 && eligibleId(r.id))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 200);
        candidates.forEach((row, rank) => {
          add(row.id, rank + 1, 0.8, 'semantic');
          similarities.set(row.id, row.similarity);
        });
      }
    } else {
      storage.db
        .prepare(`${eligibility} ORDER BY m.updated_at DESC LIMIT ? OFFSET ?`)
        .all(...values, candidateCap, 0)
        .forEach((row, rank) => add(String(row.id), rank + 1, 1, 'metadata'));
    }
    if (options.ask) {
      const intent = askIntent(query);
      if (intent.projects || intent.goals)
        storage.db
          .prepare(`${eligibility} AND m.type=? ORDER BY m.updated_at DESC LIMIT ?`)
          .all(...values, intent.projects ? 'project' : 'goal', candidateCap)
          .forEach((row, rank) => add(String(row.id), rank + 1, 1, 'question-metadata'));
    }
    // Hydrate current candidates in two bounded reads. The derived body is usable only
    // when its indexed revision hash matches canonical metadata; stale entries fall back to disk.
    const candidateIds = [...ranked.keys()];
    const canonicalRows = candidateIds.length
      ? storage.db
          .prepare(`SELECT * FROM memories WHERE id IN (${candidateIds.map(() => '?').join(',')})`)
          .all(...candidateIds)
      : [];
    const rowsById = new Map(canonicalRows.map((row) => [String(row.id), row]));
    const indexedRows = candidateIds.length
      ? storage.index
          .prepare(
            `SELECT d.id,d.body,i.hash FROM documents d JOIN indexed i ON i.id=d.id WHERE d.id IN (${candidateIds.map(() => '?').join(',')})`,
          )
          .all(...candidateIds)
      : [];
    const indexedById = new Map(indexedRows.map((row) => [String(row.id), row]));
    const hits: SearchHit[] = [];
    const time = options.at || now();
    for (const [memoryId, scored] of ranked) {
      let memory: Memory;
      try {
        const row = rowsById.get(memoryId),
          indexed = indexedById.get(memoryId);
        memory =
          !options.at && row && indexed?.hash === row.content_hash
            ? this.memories.decode(row, String(indexed.body))
            : this.memories.get(memoryId, options.at);
      } catch {
        continue;
      }
      if (
        (!q.filters.status && memory.status === 'archived') ||
        (options.includePrivate === false && memory.private)
      )
        continue;
      if (memory.valid_from! > time || (memory.valid_until && memory.valid_until <= time)) continue;
      const text = `${memory.title}\n${memory.body}\n${factText(memory)}`.toLowerCase();
      if (q.phrases.some((phrase) => !text.includes(phrase.toLowerCase()))) continue;
      let score = scored.score;
      if (q.text && text.includes(q.text.toLowerCase())) {
        score += 2;
        scored.signals.add('exact-text');
      }
      if (q.text && memory.title.toLowerCase() === q.text.toLowerCase()) {
        score += 2;
        scored.signals.add('exact-title');
      }
      if (memory.provenance.kind === 'user') {
        score += 0.004;
        scored.signals.add('user-source');
      }
      score += memory.importance * 0.003;
      const ageDays = Math.max(0, (Date.parse(time) - Date.parse(memory.updated_at)) / 86400000);
      score += 0.002 / (1 + ageDays / 30);
      if (
        q.filters.project ||
        (memory.project && q.text.toLowerCase().includes(memory.project.toLowerCase()))
      ) {
        score += 0.003;
        scored.signals.add('project');
      }
      const start = Math.max(
        0,
        memory.body
          .toLowerCase()
          .indexOf(q.terms.find((term) => memory.body.toLowerCase().includes(term)) || '') - 90,
      );
      hits.push({
        memory,
        score,
        signals: [...scored.signals],
        excerpt: (start ? '…' : '') + memory.body.slice(start, start + 340),
        matched_entities: [...scored.entities],
        semantic_similarity: similarities.get(memoryId),
        graph_links: graphLinks.get(memoryId),
      });
    }
    return hits
      .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
      .slice(options.offset || 0, (options.offset || 0) + Math.min(options.limit || 50, 200));
  }
}
