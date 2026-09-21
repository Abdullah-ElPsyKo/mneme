import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { temporary, removeTemporary, withBrain } from './helpers.js';

test('Task editing preserves identity, references and provenance, rejects stale edits and survives restart', async () => {
  const root = temporary('task-edit');
  let brain = new Brain(root);
  try {
    const memory = brain.memories.save({ title: 'Task context' });
    const task = brain.structured.task({
      title: 'Original',
      project: 'A',
      memory_id: memory.id,
      provenance: { kind: 'import', actor: 'fixture', evidence: [memory.id] },
    });
    const { id, created_at, updated_at, version, ...data } = task;
    const edit = {
      ...data,
      title: 'Revised task',
      project: 'B',
      due_at: '2027-03-04',
      status: 'doing',
      expected_version: version,
    };
    const updated = brain.structured.task(edit, id);
    assert.equal(updated.id, id);
    assert.equal(updated.created_at, created_at);
    assert.equal(updated.memory_id, memory.id);
    assert.deepEqual(updated.provenance, task.provenance);
    assert.throws(() => brain.structured.task(edit, id), /changed/);
    assert.equal(brain.structured.tasks().length, 1);
    assert.deepEqual(
      brain.memories.events.list({ aggregate: id }).map((e) => e.kind),
      ['task.updated', 'task.created'],
    );
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.structured.tasks()[0].title, 'Revised task');
    assert.equal(brain.structured.tasks()[0].due_at, '2027-03-04');
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Metadata filters combine server-side; global connection options and archive restoration retain eligibility and history', async () => {
  const root = temporary('qol-api');
  let brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, background: false });
  const inbox = brain.memories.save({ title: 'Inbox origin', status: 'inbox', type: 'capture' });
  const match = brain.memories.save({
    title: 'Needle 100% target',
    body: 'UniqueRestorationEvidence',
    type: 'decision',
    memory_class: 'procedural',
    project: 'Project One',
    tags: ['Important'],
    private: true,
  });
  const other = brain.memories.save({ title: 'Needle distractor', project: 'Project Two' });
  const edge = brain.graph.link({ from_id: inbox.id, to_id: match.id, type: 'related_to' });
  const service = await serve(brain, { port: 0 });
  const call = (path: string) =>
    fetch(service.origin + '/api' + path, { headers: { Authorization: `Bearer ${service.token}` } });
  try {
    assert.equal((await fetch(service.origin + '/api/connection-options')).status, 401);
    const filters = new URLSearchParams({
      type: 'decision',
      project: 'project one',
      memory_class: 'procedural',
      status: 'active',
      tag: 'important',
    });
    const list = await (await call('/memories?' + filters)).json();
    assert.deepEqual(
      list.map((m: any) => m.id),
      [match.id],
    );
    filters.delete('memory_class');
    filters.set('class', 'procedural');
    filters.set('q', 'Needle');
    const search = await (await call('/search?' + filters)).json();
    assert.deepEqual(
      search.hits.map((h: any) => h.memory.id),
      [match.id],
    );
    const targets = await (await call(`/connection-options?exclude=${inbox.id}&q=100%25`)).json();
    assert.deepEqual(
      targets.map((m: any) => m.id),
      [match.id],
    );
    assert.equal(
      brain.graph.connectionOptions('', inbox.id).some((m) => m.id === inbox.id),
      false,
    );
    for (let i = 0; i < 24; i++) brain.graph.entity({ name: `Paged target ${i}`, type: 'concept' });
    const page1 = brain.graph.connectionOptions('Paged target');
    const page2 = brain.graph.connectionOptions('Paged target', '', 20);
    assert.equal(page1.length, 20);
    assert.equal(page2.length, 4);
    assert.equal(new Set([...page1, ...page2].map((m) => m.id)).size, 24);
    brain.deletion.remove('memories', match.id, {
      confirmed: true,
      expected_revision: brain.deletion.preview('memories', match.id).revision,
    });
    assert.equal(
      brain.memories.list().some((m) => m.id === match.id),
      false,
    );
    assert.equal(brain.search.query('UniqueRestorationEvidence').length, 0);
    assert.equal(
      brain.graph.connectionOptions('target').some((m) => m.id === match.id),
      false,
    );
    const archived = brain.memories.get(match.id);
    const history = brain.memories.events.list({ aggregate: match.id });
    assert.deepEqual(
      brain.memories
        .list({ status: 'archived', tag: 'important', memory_class: 'procedural', q: '100%' })
        .map((m) => m.id),
      [match.id],
    );
    const restored = brain.memories.save(
      { ...brain.memories.input(archived), status: 'active', expected_version: archived.version },
      match.id,
    );
    assert.deepEqual(restored.provenance, archived.provenance);
    assert.equal(restored.body, match.body);
    assert.equal(restored.version, archived.version + 1);
    assert.deepEqual(brain.memories.events.list({ aggregate: match.id }).slice(1), history);
    assert.ok(brain.graph.inspect(match.id).relationships.find((r) => r.id === edge.id)?.valid_until);
    assert.equal(brain.search.query('UniqueRestorationEvidence')[0].memory.id, match.id);
    assert.equal(brain.search.query('UniqueRestorationEvidence', { includePrivate: false }).length, 0);
    assert.equal(brain.memories.get(other.id).version, 1);
    assert.equal((await call('/timeline?timezone=Invalid/Timezone')).status, 400);
    assert.equal((await call('/timeline?aggregate=' + match.id)).status, 400);
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('Timeline groups whole local calendar days across pages and DST without rewriting events', async () =>
  withBrain((brain) => {
    const memoryId = randomUUID(),
      otherId = randomUUID();
    const insert = (at: string, aggregate: string, kind = 'memory.updated') => {
      brain.storage.db
        .prepare(
          'INSERT INTO events(id,kind,aggregate_id,at,actor,provenance,payload,supersedes) VALUES (?,?,?,?,?,?,?,NULL)',
        )
        .run(
          randomUUID(),
          kind,
          aggregate,
          at,
          'fixture',
          JSON.stringify({ kind: 'user', actor: 'fixture', evidence: [] }),
          JSON.stringify({ memory: { title: 'History fixture' } }),
        );
    };
    // Brussels: March 29 is a 23-hour day in 2026.
    insert('2026-03-28T22:59:59.999Z', memoryId);
    insert('2026-03-28T23:00:00.000Z', memoryId);
    for (let i = 0; i < 85; i++) insert('2026-03-29T12:00:00.000Z', memoryId);
    insert('2026-03-29T21:59:59.999Z', memoryId);
    insert('2026-03-29T22:00:00.000Z', memoryId);
    insert('2026-03-29T12:00:00.000Z', otherId);
    insert('2026-03-29T12:00:00.000Z', randomUUID(), 'task.updated');
    const before = brain.storage.db.prepare('SELECT * FROM events ORDER BY seq').all();
    const groups = brain.memories.events.timeline({ timezone: 'Europe/Brussels' }) as any[];
    const group = groups.find((g) => g.aggregate_id === memoryId && g.day === '2026-03-29');
    assert.equal(group.count, 87);
    assert.equal(groups.filter((g) => g.aggregate_id === memoryId).length, 3);
    assert.equal(groups.length, 5);
    const page1 = brain.memories.events.timeline({ timezone: 'Europe/Brussels', limit: 1 });
    const page2 = brain.memories.events.timeline({ timezone: 'Europe/Brussels', limit: 1, offset: 1 });
    assert.notEqual(page1[0].id, page2[0].id);
    const options = { timezone: 'Europe/Brussels', aggregate: memoryId, day: '2026-03-29' };
    const events = [
      ...brain.memories.events.timeline(options),
      ...brain.memories.events.timeline({ ...options, offset: 80 }),
    ] as any[];
    assert.equal(events.length, 87);
    assert.equal(new Set(events.map((e) => e.id)).size, 87);
    for (let i = 1; i < events.length; i++)
      assert.ok(
        events[i - 1].at > events[i].at ||
          (events[i - 1].at === events[i].at && events[i - 1].seq > events[i].seq),
      );
    assert.deepEqual(brain.storage.db.prepare('SELECT * FROM events ORDER BY seq').all(), before);
  }));
