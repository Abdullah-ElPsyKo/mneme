import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrain } from './helpers.js';
import { settingsSchema } from '../server/security/settings.js';

test('Ask selects bounded task state, goal memories and project lifecycle without inventing state', async () => {
  await withBrain(async (brain) => {
    let calls = 0;
    brain.provider.generate = async ({ prompt }) => {
      calls++;
      assert.match(prompt, /task_id/);
      return 'Check FW01. [S1]';
    };
    assert.match((await brain.ask('What tasks do I have?', true)).answer!, /haven't recorded/);
    assert.equal(calls, 0);
    const task = brain.structured.task({ title: 'Check FW01', project: 'FORGELINE', due_at: '2027-01-01' });
    brain.structured.task({ title: 'Old completed task', status: 'done' });
    const goal = brain.memories.save({ title: 'Learn networking', type: 'goal' });
    const active = brain.memories.save({ title: 'FORGELINE', type: 'project', project_state: 'active' });
    brain.memories.save({ title: 'Later', type: 'project', project_state: 'planned' });
    const both = (await brain.context('Ok chief, what are our goals, any tasks?')).context;
    assert.ok(both.evidence.some((e) => e.memory_id === goal.id));
    assert.ok(both.evidence.some((e) => e.task_id === task.id && e.status === 'open'));
    assert.equal(
      (await brain.context('What tasks for FORGELINE?')).context.evidence.filter((e) => e.task_id).length,
      1,
    );
    assert.equal((await brain.context('What tasks for Saturn?')).context.evidence.length, 0);
    assert.equal(
      (await brain.context('What is FORGELINE?')).context.evidence.some((e) => e.task_id),
      false,
    );
    assert.deepEqual(
      (await brain.context('What projects am I currently working on?')).context.evidence.map(
        (e) => e.memory_id,
      ),
      [active.id],
    );
    await brain.ask('What tasks do I have?', true);
    assert.equal(calls, 1);
    assert.equal(brain.conversations.list()[0].evidence[0].task_id, task.id);
    assert.equal(brain.structured.tasks().find((t) => t.id === task.id)!.version, 1);
    const named = brain.memories.save({ title: 'CHIEF', body: 'A named local software fixture.' });
    assert.deepEqual(
      (await brain.context('What is CHIEF?')).context.evidence.map((e) => e.memory_id),
      [named.id],
    );
    for (let i = 0; i < 25; i++) brain.structured.task({ title: `Task ${i}` });
    const bounded = (await brain.context('What tasks do I have?', false, false, 32000)).context;
    assert.equal(bounded.evidence.filter((e) => e.task_id).length, 20);
    const compact = (await brain.context('What tasks do I have?', false, false, 300)).context;
    assert.ok(compact.estimated_tokens <= 300);
    assert.deepEqual(
      compact.evidence.map((e) => e.citation),
      compact.evidence.map((_, i) => `S${i + 1}`),
    );
  });
});

test('Task evidence excludes archived tasks and private, expired, archived or superseded linked memories', async () => {
  await withBrain(async (brain) => {
    for (const data of [
      { private: true },
      { status: 'archived' },
      { valid_until: '2020-01-01T00:00:00.000Z', valid_from: '2019-01-01T00:00:00.000Z' },
    ]) {
      const m = brain.memories.save({ title: 'Restricted context', ...data });
      brain.structured.task({ title: 'Restricted task', memory_id: m.id });
      brain.structured.task({
        title: 'Restricted provenance task',
        provenance: { kind: 'user', actor: 'fixture', evidence: [m.id] },
      });
    }
    const old = brain.memories.save({ title: 'Old context' });
    brain.memories.save({ title: 'New context', supersedes: old.id });
    brain.structured.task({ title: 'Superseded task', memory_id: old.id });
    const archived = brain.structured.task({ title: 'Archived task' });
    brain.memories.events.append(
      'task.archived',
      archived.id,
      { id: archived.id },
      { kind: 'user', actor: 'fixture', evidence: [] },
    );
    assert.equal((await brain.context('What tasks do I have?')).context.evidence.length, 0);
  });
});

test('Preference defaults are backward compatible and custom entity/relationship types remain open-ended', async () => {
  await withBrain((brain) => {
    assert.equal(settingsSchema.parse({}).text_size, 'default');
    assert.equal(settingsSchema.parse({}).graph_labels, true);
    brain.settings.update({ ...brain.settings.data, text_size: 'large', graph_labels: false });
    brain.settings.reload();
    assert.equal(brain.settings.data.text_size, 'large');
    const a = brain.graph.entity({ name: 'FW01', type: 'custom_firewall' });
    const b = brain.graph.entity({ name: 'Network', type: 'custom_network' });
    const r = brain.graph.link({ from_id: a.id, to_id: b.id, type: 'custom_link' });
    assert.equal(brain.graph.inspect(a.id).entity.type, 'custom_firewall');
    assert.equal(r.type, 'custom_link');
    assert.equal(brain.doctor(true).ok, true);
  });
});

test('Permanent memory erasure removes dependent task answer snapshots and retains unrelated task answers', async () => {
  await withBrain(async (brain) => {
    const memory = brain.memories.save({ title: 'Private erasure fixture' });
    const dependent = brain.structured.task({ title: 'Dependent task', memory_id: memory.id });
    const unrelated = brain.structured.task({ title: 'Unrelated task' });
    await brain.ask('What tasks are dependent?');
    await brain.ask('What tasks are unrelated?');
    assert.equal(brain.conversations.list().length, 2);
    brain.deletion.permanent(memory.id, {
      confirmed: true,
      expected_revision: brain.deletion.permanentPreview(memory.id).revision,
    });
    const turns = brain.conversations.list();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].evidence[0].task_id, unrelated.id);
    assert.ok(!JSON.stringify(turns).includes(dependent.id));
    assert.equal(brain.doctor(true).ok, true);
  });
});
