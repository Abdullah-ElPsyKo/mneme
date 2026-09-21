import { z } from 'zod';
import type { Brain } from '../app.js';
import { AppError } from '../core/types.js';
import { hash, parse } from '../core/util.js';
import { archived, retireReferences } from './lifecycle.js';
import { eraseMemory } from './erasure.js';

const kinds = {
  memories: 'memory',
  entities: 'entity',
  tasks: 'task',
  sources: 'source',
  records: 'record',
  conversations: 'ask',
  relationships: 'relationship',
  proposals: 'proposal',
} as const;
export type DeletionKind = keyof typeof kinds;
const confirmation = z
  .object({ confirmed: z.literal(true), expected_revision: z.string().length(64) })
  .strict();
export class Deletion {
  constructor(readonly brain: Brain) {}
  permanentPreview(id: string) {
    const preview = this.preview('memories', id);
    return {
      ...preview,
      deleted: false,
      description:
        'Permanently remove this memory and all its revisions, connections, exclusive source files, and dependent saved Ask turns, proposals, tasks and records from this brain. References in other memories are cleared. Shared original evidence remains. This cannot be undone. Existing backups, exports and external copies are unchanged and can still contain this memory.',
    };
  }
  permanent(id: string, input: unknown) {
    const data = confirmation.parse(input);
    return eraseMemory(this.brain, id, () => {
      if (this.permanentPreview(id).revision !== data.expected_revision)
        throw new AppError(409, 'This memory or its connections changed. Review permanent deletion again.');
    });
  }
  preview(
    kind: string,
    id: string,
  ): {
    kind: DeletionKind;
    id: string;
    title: string;
    deleted: boolean;
    description: string;
    revision: string;
  } {
    if (!Object.hasOwn(kinds, kind)) throw new AppError(404, 'This object type cannot be deleted');
    z.string().uuid().parse(id);
    const category = kind as DeletionKind;
    const table = category === 'conversations' ? 'ask_turns' : category;
    const row = this.brain.storage.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
    if (!row) throw new AppError(404, 'Object not found');
    if (category === 'proposals' && row.status === 'accepted')
      throw new AppError(
        409,
        'This proposal is already accepted. Delete its resulting object instead; review history is retained.',
      );
    // Memory-backed entities have one lifecycle: their memory revision.
    if (category === 'entities' && row.memory_id) return this.preview('memories', row.memory_id);
    const deleted =
      category === 'memories'
        ? row.status === 'archived'
        : category === 'proposals'
          ? row.status === 'rejected'
          : category === 'relationships'
            ? !!row.valid_until
            : archived(this.brain.storage, kinds[category], id);
    const relations = ['memories', 'entities'].includes(category)
      ? this.brain.storage.db
          .prepare(
            'SELECT id FROM relationships WHERE (from_id=? OR to_id=?) AND valid_until IS NULL ORDER BY id',
          )
          .all(id, id)
      : [];
    const turn = category === 'conversations' ? parse<any>(row.data) : null;
    if (turn?.status === 'running' && !deleted)
      throw new AppError(409, 'Stop generation before deleting this conversation');
    const endpoints =
      category === 'relationships'
        ? this.brain.storage.db
            .prepare(
              'SELECT a.name AS from_name,b.name AS to_name FROM entities a,entities b WHERE a.id=? AND b.id=?',
            )
            .get(row.from_id, row.to_id)
        : null;
    const title =
      row.title ||
      row.name ||
      (category === 'proposals' ? parse<any>(row.payload).title || `${row.kind} suggestion` : null) ||
      turn?.question ||
      (endpoints
        ? `${endpoints.from_name} → ${endpoints.to_name} (${row.type.replaceAll('_', ' ')})`
        : `${row.type} · ${row.valid_from}`);
    const descriptions: Record<DeletionKind, string> = {
      memories: `Remove this ${row.type === 'project' ? 'project' : 'memory'} from current views, search and new AI context. End ${relations.length} active connection(s). Related notes, tasks, project labels and original sources stay. Markdown and revision history remain; browse Notes → Archived and use Restore memory to make it active again.`,
      entities: `Remove this entity from the current graph and end ${relations.length} active connection(s). Related memories and their text stay. Historical graph snapshots and provenance remain.`,
      relationships:
        'End this connection in the current graph. Both endpoints and the historical connection remain.',
      tasks: 'Remove this task from all task lists. Its linked memory, project and task history remain.',
      sources:
        'Remove this source from the Sources list. Its linked memory stays searchable; delete that memory separately if needed. Original bytes are retained for shared references, revision history and recovery.',
      records:
        'Remove this structured record from current record queries. Superseding records and historical events remain.',
      conversations:
        'Remove this question and answer from Ask history. Memories, cited evidence and the append-only audit history remain.',
      proposals:
        'Reject this pending suggestion. No suggested changes will be applied. Its evidence and review history remain.',
    };
    return {
      kind: category,
      id,
      title,
      deleted,
      description: descriptions[category],
      revision: hash(JSON.stringify({ row, relations, deleted })),
    };
  }
  remove(kind: string, id: string, input: unknown) {
    const data = confirmation.parse(input);
    const preview = this.preview(kind, id);
    if (preview.revision !== data.expected_revision)
      throw new AppError(409, 'This item or its connections changed. Review the deletion again.');
    if (preview.deleted) return { ...preview, deleted: true };
    const { brain } = this;
    if (preview.kind === 'memories') {
      const memory = brain.memories.get(preview.id);
      brain.memories.save(
        {
          ...brain.memories.input(memory),
          status: 'archived',
          provenance: {
            ...memory.provenance,
            kind: 'user',
            actor: 'user',
            extraction_method: 'user-deletion',
          },
        },
        memory.id,
        undefined,
        () => {
          if (this.preview(kind, id).revision !== data.expected_revision)
            throw new AppError(409, 'Item or connections changed; review deletion again');
        },
      );
    } else if (preview.kind === 'relationships') brain.graph.unlink(id);
    else if (preview.kind === 'proposals') brain.proposals.resolve(id, 'reject');
    else
      brain.storage.transaction(() => {
        // Recheck while holding the writer lock against worker/process changes.
        if (this.preview(kind, id).revision !== data.expected_revision)
          throw new AppError(409, 'Item changed; review deletion again');
        const table = preview.kind === 'conversations' ? 'ask_turns' : preview.kind;
        const row = brain.storage.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)!;
        const payload =
          preview.kind === 'entities'
            ? {
                entity: {
                  ...row,
                  properties: parse(row.properties),
                  provenance: parse(row.provenance),
                  status: 'archived',
                },
              }
            : { id, title: preview.title };
        brain.memories.events.append(`${kinds[preview.kind]}.archived`, id, payload, {
          kind: 'user',
          actor: 'user',
          evidence: [],
        });
        if (preview.kind === 'entities') retireReferences(brain.storage, id);
      });
    brain.jobs.emit('change');
    return { ...preview, deleted: true };
  }
}
