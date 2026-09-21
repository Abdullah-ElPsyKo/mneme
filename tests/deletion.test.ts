import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { restoreBackup } from '../server/backup/backup.js';
import { temporary, removeTemporary, withBrain } from './helpers.js';

const remove = (brain: Brain, kind: string, id: string) =>
  brain.deletion.remove(kind, id, {
    confirmed: true,
    expected_revision: brain.deletion.preview(kind, id).revision,
  });

test('Archival schema upgrade preserves an existing v2 brain and marks the required reader version', async () => {
  const root = temporary('delete-upgrade');
  let brain = new Brain(root);
  try {
    const memory = brain.memories.save({
      title: 'Existing v2 memory',
      body: 'Retain existing canonical data.',
    });
    const bytes = readFileSync(join(root, memory.path));
    const events = brain.status().events;
    await brain.close();
    const db = new DatabaseSync(join(root, 'database/brain.db'));
    db.exec(
      'DROP INDEX memories_project_state; ALTER TABLE memories DROP COLUMN project_state; DROP INDEX ask_turns_conversation; ALTER TABLE ask_turns DROP COLUMN conversation_id; DROP TABLE ask_chat; DROP INDEX events_kind_aggregate; ALTER TABLE memories DROP COLUMN facts; DROP TABLE erased_fingerprints; DROP TABLE erasure_cleanup; DELETE FROM migrations WHERE version>=3;',
    );
    db.close();
    brain = new Brain(root);
    assert.deepEqual(readFileSync(join(root, memory.path)), bytes);
    assert.equal(brain.status().events, events);
    assert.equal(brain.memories.get(memory.id).body, memory.body);
    assert.equal(brain.storage.db.prepare('SELECT max(version) AS v FROM migrations').get()!.v, 6);
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Memory/project deletion retains revisions and dependents, clears retrieval, survives restart and stale Markdown', async () => {
  const root = temporary('delete-memory');
  let brain = new Brain(root);
  try {
    const m = brain.memories.save({
      title: 'Disposable project',
      type: 'project',
      body: 'UniqueDeletionNeedle',
    });
    const original = readFileSync(join(root, m.path), 'utf8');
    const child = brain.memories.save({
      title: 'Keep this note',
      project: m.title,
      body: 'Unrelated content',
    });
    const task = brain.structured.task({ title: 'Keep this task', memory_id: m.id, project: m.title });
    const edge = brain.graph.link({ from_id: m.id, to_id: child.id, type: 'contains' });
    const proposal = brain.proposals.create({
      kind: 'relationship',
      payload: { from_id: m.id, to_id: child.id, type: 'uses' },
      provenance: { kind: 'user', actor: 'user', evidence: [] },
    });
    brain.search.storeVector(m, [1, 0], 'fixture');
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    remove(brain, 'memories', m.id);
    assert.equal(brain.memories.get(m.id).status, 'archived');
    assert.equal(brain.memories.get(m.id).version, 2);
    assert.equal(brain.memories.get(m.id, before).body, m.body);
    assert.equal(
      brain.memories.list().some((x) => x.id === m.id),
      false,
    );
    assert.equal(brain.search.query('UniqueDeletionNeedle').length, 0);
    assert.equal((await brain.context('status:archived UniqueDeletionNeedle')).context.evidence.length, 0);
    assert.equal(
      brain.graph.view().entities.some((x) => x.id === m.id),
      false,
    );
    assert.equal(brain.graph.view().relationships.length, 0);
    assert.equal(
      brain.graph.view({ at: before }).relationships.some((x) => x.id === edge.id),
      true,
    );
    assert.equal(brain.structured.tasks()[0].id, task.id);
    assert.equal(brain.memories.get(child.id).status, 'active');
    assert.equal(
      brain.proposals.list().some((x) => x.id === proposal.id),
      false,
    );
    assert.throws(() => brain.graph.link({ from_id: m.id, to_id: child.id, type: 'uses' }), /endpoint/);
    // A model result that began before deletion must not publish a stale vector.
    brain.search.storeVector(m, [1, 0], 'fixture');
    for (const [table, column] of [
      ['documents', 'id'],
      ['chunks', 'memory_id'],
      ['vectors', 'memory_id'],
    ])
      assert.equal(
        brain.storage.index.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(m.id)!.n,
        0,
      );
    await brain.close();
    brain = new Brain(root);
    writeFileSync(join(root, m.path), original); // stale external copy cannot resurrect it
    brain.memories.reconcile(true);
    brain.search.rebuild();
    assert.equal(brain.memories.get(m.id).status, 'archived');
    assert.equal(brain.search.query('UniqueDeletionNeedle').length, 0);
    assert.equal(brain.doctor(true).ok, true, JSON.stringify(brain.doctor(true)));
    assert.match(readFileSync(join(root, m.path), 'utf8'), /status: archived/);
    const revision = brain.memories.get(m.id);
    brain.memories.save({ ...brain.memories.input(revision), status: 'active' }, m.id);
    assert.equal(brain.search.query('UniqueDeletionNeedle')[0].memory.id, m.id);
    assert.equal(
      brain.graph.view().relationships.length,
      0,
      'Restoring content must not silently restore ended edges',
    );
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Entity and relationship deletion preserve historical graphs without dangling live edges', () =>
  withBrain(async (brain) => {
    const a = brain.graph.entity({ name: 'Disposable entity', type: 'device' });
    const b = brain.graph.entity({ name: 'Survivor', type: 'device' });
    const first = brain.graph.link({ from_id: a.id, to_id: b.id, type: 'uses' });
    remove(brain, 'relationships', first.id);
    assert.equal(brain.graph.view().relationships.length, 0);
    const second = brain.graph.link({ from_id: a.id, to_id: b.id, type: 'uses' });
    const before = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    remove(brain, 'entities', a.id);
    assert.equal(brain.graph.view().entities.length, 1);
    assert.equal(brain.graph.view().relationships.length, 0);
    assert.equal(
      brain.graph.view({ at: before }).relationships.some((x) => x.id === second.id),
      true,
    );
    assert.equal(
      brain.graph.view({ at: new Date().toISOString() }).entities.some((x) => x.id === a.id),
      false,
    );
    assert.throws(() => brain.graph.link({ from_id: a.id, to_id: b.id, type: 'uses' }), /endpoint/);
    assert.equal(brain.doctor(true).ok, true);
  }));

test('Source, task, record and Ask archives survive backup/restore and keep shared evidence intact', () =>
  withBrain(async (brain) => {
    const imported = brain.ingestion.file('shared.txt', Buffer.from('Shared immutable evidence'));
    const survivor = brain.memories.save({
      title: 'Second reference',
      body: 'Keep this evidence',
      provenance: {
        kind: 'user',
        actor: 'user',
        source_id: imported.source.id,
        evidence: [imported.source.id],
      },
    });
    const task = brain.structured.task({ title: 'Disposable task', memory_id: survivor.id });
    const record = brain.structured.record({ type: 'measurement', data: { value: 12 } });
    const newer = brain.structured.record({
      type: 'measurement',
      data: { value: 13 },
      supersedes: record.id,
    });
    await brain.ask('Shared', false);
    const turn = brain.conversations.list()[0];
    for (const [kind, id] of [
      ['sources', imported.source.id],
      ['tasks', task.id],
      ['records', record.id],
      ['conversations', turn.id],
    ])
      remove(brain, kind, id);
    assert.equal(brain.memories.objects.list().length, 0);
    assert.equal(brain.structured.tasks().length, 0);
    assert.equal(brain.structured.records()[0].id, newer.id);
    assert.equal(brain.conversations.list().length, 0);
    assert.equal(brain.memories.get(imported.memory.id).status, 'inbox');
    assert.equal(brain.memories.get(survivor.id).provenance.source_id, imported.source.id);
    assert.equal(
      readFileSync(brain.memories.objects.path(imported.source.hash), 'utf8'),
      'Shared immutable evidence',
    );
    assert.throws(
      () => brain.structured.task({ title: 'Resurrect', expected_version: task.version }, task.id),
      /deleted/,
    );
    const backup = await brain.backups.create();
    const parent = temporary('delete-restore');
    try {
      const path = join(parent, 'restored');
      await restoreBackup(backup.path, path);
      const restored = new Brain(path);
      try {
        assert.equal(restored.memories.objects.list().length, 0);
        assert.equal(restored.structured.tasks().length, 0);
        assert.equal(restored.structured.records().length, 1);
        assert.equal(restored.conversations.list().length, 0);
        assert.equal(
          readFileSync(restored.memories.objects.path(imported.source.hash), 'utf8'),
          'Shared immutable evidence',
        );
        assert.equal(restored.doctor(true).ok, true);
      } finally {
        await restored.close();
      }
    } finally {
      removeTemporary(parent);
    }
  }));

test('Deletion preview is read-only, rejects stale/unconfirmed mutations, and rollback preserves memory plus edges', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'Review me', body: 'Original' });
    const n = brain.memories.save({ title: 'Neighbor' });
    const preview = brain.deletion.preview('memories', m.id);
    const count = brain.status().events;
    assert.equal(brain.status().events, count);
    assert.throws(() => brain.deletion.remove('memories', m.id, {}));
    brain.graph.link({ from_id: m.id, to_id: n.id, type: 'uses' });
    assert.throws(
      () => brain.deletion.remove('memories', m.id, { confirmed: true, expected_revision: preview.revision }),
      /changed/,
    );
    brain.storage.db.exec(
      "CREATE TRIGGER fail_archive BEFORE UPDATE OF valid_until ON relationships BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    assert.throws(() => remove(brain, 'memories', m.id), /injected failure/);
    assert.equal(brain.memories.get(m.id).status, 'active');
    assert.equal(brain.memories.get(m.id).version, 1);
    assert.equal(brain.graph.view().relationships.length, 1);
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 0);
    assert.equal(brain.doctor(true).ok, true);
  }));

test('Authenticated deletion API requires explicit reviewed confirmation and excludes deleted memory from context', async () => {
  const root = temporary('delete-api');
  const brain = new Brain(root);
  const m = brain.memories.save({ title: 'API deletion fixture', body: 'DeleteApiNeedle' });
  const service = await serve(brain, { port: 0 });
  const path = service.origin + `/api/deletion/memories/${m.id}`;
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(path, { method: 'DELETE' })).status, 401);
    const preview = await (await fetch(path, { headers })).json();
    assert.equal((await fetch(path, { headers, method: 'DELETE', body: '{}' })).status, 400);
    assert.equal(brain.memories.get(m.id).status, 'active');
    assert.equal(
      (
        await fetch(path, {
          headers,
          method: 'DELETE',
          body: JSON.stringify({ confirmed: true, expected_revision: preview.revision }),
        })
      ).status,
      200,
    );
    assert.equal(brain.search.query('DeleteApiNeedle').length, 0);
    assert.equal((await brain.ask('DeleteApiNeedle', true)).context.evidence.length, 0);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('Interrupted Markdown flush replays the archived revision and clears stale indexes on restart', async () => {
  const root = temporary('delete-recovery');
  let brain = new Brain(root);
  try {
    const memory = brain.memories.save({ title: 'Recover deletion', body: 'InterruptedArchiveNeedle' });
    const flush = brain.memories.flush.bind(brain.memories);
    brain.memories.flush = () => {
      throw new Error('simulated write interruption');
    };
    assert.throws(() => remove(brain, 'memories', memory.id), /interruption/);
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);
    assert.equal(brain.search.query('InterruptedArchiveNeedle').length, 0);
    brain.memories.flush = flush;
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.memories.get(memory.id).status, 'archived');
    assert.equal(brain.search.query('InterruptedArchiveNeedle').length, 0);
    assert.equal(
      brain.storage.index.prepare('SELECT count(*) AS n FROM documents WHERE id=?').get(memory.id)!.n,
      0,
    );
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Pending suggestions can be rejected with confirmation without deleting their evidence', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'Keep evidence' });
    const proposal = brain.proposals.create({
      kind: 'memory',
      payload: { title: 'Suggested content' },
      evidence: [m.id],
      provenance: { kind: 'user', actor: 'user', evidence: [m.id] },
    });
    remove(brain, 'proposals', proposal.id);
    assert.equal(brain.proposals.list().length, 0);
    assert.equal(brain.proposals.list('rejected')[0].id, proposal.id);
    assert.equal(brain.memories.get(m.id).status, 'active');
    const turn = brain.conversations.begin(
      'Running',
      { query: '', budget: 3000, estimated_tokens: 0, evidence: [], conflicts: [], omitted: [], prompt: '' },
      null,
    );
    assert.throws(() => brain.deletion.preview('conversations', turn.id), /Stop generation/);
  }));
