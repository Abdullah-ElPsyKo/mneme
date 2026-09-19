import { z } from 'zod';
import { AppError, provenanceSchema, memorySchema } from '../core/types.js';
import { id, now, parse } from '../core/util.js';
import type { Memories } from './memories.js';
import type { Graph } from '../graph/graph.js';
import { activeObject } from './lifecycle.js';
const proposalSchema = z
  .object({
    kind: z.enum(['memory', 'relationship']),
    payload: z.record(z.string(), z.unknown()),
    evidence: z.array(z.string().max(100)).max(100).default([]),
    provenance: provenanceSchema,
  })
  .strict();
export class Proposals {
  constructor(
    readonly memories: Memories,
    readonly graph: Graph,
  ) {}
  create(input: unknown) {
    const data = proposalSchema.parse(input);
    if (JSON.stringify(data.payload).length > 2_100_000) throw new AppError(400, 'Proposal too large');
    const proposal = {
      ...data,
      id: id(),
      status: 'pending',
      created_at: now(),
      resolved_at: null,
      result_id: null,
    };
    this.memories.storage.transaction(() => {
      this.memories.storage.db
        .prepare('INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          proposal.id,
          proposal.kind,
          JSON.stringify(proposal.payload),
          JSON.stringify(proposal.evidence),
          JSON.stringify(proposal.provenance),
          proposal.status,
          proposal.created_at,
          null,
          null,
        );
      this.memories.events.append('proposal.created', proposal.id, { proposal }, data.provenance);
    });
    return proposal;
  }
  list(status = 'pending', limit = 100, offset = 0): any[] {
    return this.memories.storage.db
      .prepare('SELECT * FROM proposals WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(status, Math.min(limit, 500), offset)
      .map((row) => ({
        ...row,
        payload: parse(row.payload),
        evidence: parse(row.evidence),
        provenance: parse(row.provenance),
      }));
  }
  resolve(proposalId: string, action: 'accept' | 'reject', edited?: Record<string, unknown>) {
    const row = this.memories.storage.db.prepare('SELECT * FROM proposals WHERE id=?').get(proposalId) as any;
    if (!row) throw new AppError(404, 'Proposal not found');
    if (row.status !== 'pending') throw new AppError(409, 'Proposal has already been resolved');
    const provenance = { ...parse(row.provenance), evidence: parse(row.evidence), actor: 'user-reviewed' };
    let resultId: string | null = null;
    if (action === 'accept') {
      const payload = edited ?? parse<Record<string, unknown>>(row.payload);
      // A stable accepted ID is recorded before resolution; recovery finds it through proposal evidence.
      const existing = this.memories.storage.db
        .prepare(
          "SELECT aggregate_id FROM events WHERE kind IN ('memory.created','memory.updated','relationship.created') AND json_extract(provenance,'$.parent_event')=? LIMIT 1",
        )
        .get(proposalId);
      if (existing) resultId = String(existing.aggregate_id);
      else if (row.kind === 'memory') {
        const { memory_id, ...changes } = payload;
        const targetId = memory_id === undefined ? undefined : z.string().uuid().parse(memory_id);
        let base = {};
        if (targetId !== undefined) {
          if (!Number.isInteger(changes.expected_version))
            throw new AppError(400, 'A memory update proposal requires expected_version');
          base = this.memories.input(this.memories.get(targetId));
        }
        resultId = this.memories.save(
          memorySchema.parse({
            ...base,
            ...changes,
            provenance: { ...provenance, parent_event: proposalId },
          }),
          targetId,
        ).id;
      } else
        resultId = String(
          this.graph.link({ ...payload, provenance: { ...provenance, parent_event: proposalId } }).id,
        );
    }
    this.memories.storage.transaction(() => {
      this.memories.storage.db
        .prepare('UPDATE proposals SET status=?,resolved_at=?,result_id=? WHERE id=? AND status=?')
        .run(action === 'accept' ? 'accepted' : 'rejected', now(), resultId, proposalId, 'pending');
      this.memories.events.append(
        `proposal.${action === 'accept' ? 'accepted' : 'rejected'}`,
        proposalId,
        { result_id: resultId, edited: !!edited },
        { kind: 'user', actor: 'user', evidence: [proposalId] },
      );
    });
    return { id: proposalId, status: action === 'accept' ? 'accepted' : 'rejected', result_id: resultId };
  }
  consolidate(limit = 100) {
    const storage = this.memories.storage;
    const cursor = storage.state('consolidation_cursor') || 0;
    const changes = storage.db
      .prepare(
        "SELECT seq,aggregate_id,payload FROM events WHERE seq>? AND kind IN ('memory.created','memory.updated') ORDER BY seq LIMIT ?",
      )
      .all(cursor, limit);
    let count = 0,
      last = cursor;
    const issues: any[] = [];
    for (const event of changes) {
      const m = parse(event.payload).memory;
      last = Number(event.seq);
      if (storage.db.prepare('SELECT status FROM memories WHERE id=?').get(m.id)?.status === 'archived')
        continue;
      const links = [...String(m.body).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1]);
      for (const title of [...new Set(links)]) {
        const matches = storage.db
          .prepare(
            `SELECT id FROM entities WHERE name=? COLLATE NOCASE AND id!=? AND ${activeObject('entity', 'entities.id')} AND (memory_id IS NULL OR memory_id IN (SELECT id FROM memories WHERE status!='archived')) LIMIT 2`,
          )
          .all(title, m.id);
        if (matches.length !== 1) {
          issues.push({
            memory_id: m.id,
            kind: matches.length ? 'ambiguous-link' : 'unresolved-link',
            name: title,
          });
          continue;
        }
        const target = String(matches[0].id);
        if (
          storage.db
            .prepare('SELECT 1 FROM relationships WHERE from_id=? AND to_id=? AND valid_until IS NULL')
            .get(m.id, target)
        )
          continue;
        if (
          storage.db
            .prepare(
              "SELECT 1 FROM proposals WHERE status!='rejected' AND kind='relationship' AND json_extract(payload,'$.from_id')=? AND json_extract(payload,'$.to_id')=?",
            )
            .get(m.id, target)
        )
          continue;
        this.create({
          kind: 'relationship',
          payload: { from_id: m.id, to_id: target, type: 'references' },
          evidence: [m.id],
          provenance: {
            kind: 'derived',
            actor: 'consolidation',
            extraction_method: 'explicit-wikilink',
            evidence: [m.id],
          },
        });
        count++;
      }
      for (const fact of this.memories.normalize(m).facts) {
        const conflicts = storage.db
          .prepare(
            "SELECT DISTINCT m.id FROM memories m, json_each(m.facts) f WHERE json_extract(f.value,'$.key')=? AND json_extract(f.value,'$.value')!=? AND m.id!=? AND m.status!='archived' AND m.supersedes IS NOT ?",
          )
          .all(fact.key, fact.value, m.id, m.id);
        for (const conflict of conflicts)
          issues.push({
            memory_id: m.id,
            kind: 'fact-conflict',
            other_id: conflict.id,
            fact_key: fact.key,
          });
      }
      last = Number(event.seq);
    }
    const orphanCount = Number(
      storage.db
        .prepare(
          "SELECT count(*) AS n FROM memories m WHERE status!='archived' AND NOT EXISTS(SELECT 1 FROM relationships r WHERE (r.from_id=m.id OR r.to_id=m.id) AND r.valid_until IS NULL)",
        )
        .get()!.n,
    );
    storage.state('consolidation_cursor', last);
    storage.state('consolidation', {
      at: now(),
      processed: changes.length,
      proposals: count,
      issues,
      orphan_count: orphanCount,
    });
    return {
      processed: changes.length,
      proposals: count,
      issues,
      orphan_count: orphanCount,
      more: changes.length === limit,
    };
  }
}
