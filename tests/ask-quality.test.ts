import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { compileContext } from '../server/context/compiler.js';
import { askSystem } from '../server/context/style.js';
import { withBrain, temporary, removeTemporary } from './helpers.js';
import { askFixture } from './ask-fixture.js';

test('Projects with identical prose retain separate status evidence, including Project B completed', async () => {
  await withBrain(async (brain) => {
    const projects = ['A', 'B', 'C'].map((letter, i) =>
      brain.memories.save({
        title: `Project ${letter}`,
        type: 'project',
        memory_class: 'semantic',
        status: i ? 'completed' : 'active',
        body: 'Implementation plans are documented here.',
      }),
    );
    const broad = await brain.context('What projects are active and which are completed?');
    assert.equal(broad.context.evidence.length, 3);
    const b = await brain.context('Is Project B active or completed?');
    assert.equal(b.context.evidence.length, 1);
    assert.equal(b.context.evidence[0].memory_id, projects[1].id);
    assert.equal(b.context.evidence[0].status, 'completed');
    assert.match(b.context.prompt, /"memory_class":"semantic"/);
  });
});

test('Narrow recall excludes unrelated candidates; project overview preserves breadth and explicit metadata', async () => {
  await withBrain(async (brain) => {
    const f = askFixture(brain);
    const cases: [string, string[]][] = [
      ['What is FORGELINE and what is its purpose?', [f.a.id, f.direction.id, f.goal.id]],
      ["What's FORGELINE?", [f.a.id, f.direction.id, f.goal.id]],
      ['What projects am I actively working on and which are completed?', [f.a.id, f.b.id, f.c.id]],
      ['What is my hardware configuration?', [f.hardware.id]],
      ['What is my test GPU maximum price?', [f.price.id]],
      ['Is AWS Architecture active or completed?', [f.b.id]],
      ['What is the password for my lunar telescope?', []],
      ['What are my current technical goals?', [f.goal.id]],
    ];
    for (const [query, ids] of cases) {
      const result = await brain.context(query);
      assert.deepEqual(result.context.evidence.map((e) => e.memory_id).sort(), ids.sort(), query);
      assert.equal(result.diagnostics.evidence_count, ids.length);
      if (ids.length === 1) assert.ok(result.diagnostics.candidate_count > ids.length, query);
      console.log(JSON.stringify({ query, ...result.diagnostics }));
      for (const [i, e] of result.context.evidence.entries()) assert.equal(e.citation, `S${i + 1}`);
    }
    const status = (await brain.context('Is AWS Architecture active or completed?')).context;
    assert.ok(status.prompt.includes('"status":"completed"'));
    assert.equal(status.evidence[0].type, 'project');
    assert.equal(status.evidence[0].memory_class, 'semantic');
    assert.equal(status.evidence[0].current, true);
    assert.equal(status.evidence[0].project, 'AWS Architecture');
    assert.deepEqual(status.evidence[0].facts, [{ key: 'aws.deployed', value: 'true' }]);
    assert.ok(status.evidence[0].valid_from);
    assert.deepEqual(
      (await brain.context('What is my test GPU maximum price?')).context.evidence[0].facts,
      f.price.facts,
    );
    assert.equal(
      brain.memories.get(f.price.id).body,
      f.price.body,
      'FTS hydration must not append facts to canonical body',
    );
  });
});

test('Named-project comparisons and explicit graph relationships retain useful synthesis without generic neighbors', async () => {
  await withBrain(async (brain) => {
    const f = askFixture(brain);
    const comparison = await brain.context('Compare FORGELINE and AWS Architecture');
    const ids = comparison.context.evidence.map((e) => e.memory_id);
    assert.ok(ids.includes(f.a.id) && ids.includes(f.b.id));
    assert.ok(!ids.includes(f.hardware.id) && !ids.includes(f.c.id));
    const security = brain.memories.save({
      title: 'Management boundary',
      body: 'Only the jump host may administer the domain.',
    });
    brain.graph.link({ from_id: f.a.id, to_id: security.id, type: 'secured_by' });
    const result = await brain.context('How is FORGELINE secured?');
    assert.ok(result.context.evidence.some((e) => e.memory_id === security.id));
    assert.match(result.context.prompt, /secured_by/);
    assert.ok(!result.context.evidence.some((e) => f.unrelated.some((m) => m.id === e.memory_id)));
    const turn = brain.conversations.begin(result.context.query, result.context, null);
    brain.conversations.finish(turn.id, 'The jump host controls management. [S1]');
    brain.deletion.permanent(f.a.id, {
      confirmed: true,
      expected_revision: brain.deletion.permanentPreview(f.a.id).revision,
    });
    assert.equal(
      brain.conversations.list().length,
      0,
      'Graph evidence retains endpoint dependencies for permanent deletion',
    );
  });
});

test('Current conflicts survive selection; archives, privacy, expiry and supersession remain excluded', async () => {
  await withBrain(async (brain) => {
    const f = askFixture(brain);
    const motor1 = brain.memories.save({
      title: 'Robot arm motor choice',
      body: 'You selected NEMA17 for the robotic arm.',
      facts: [{ key: 'robot.motor', value: 'NEMA17' }],
    });
    const motor2 = brain.memories.save({
      title: 'Robot arm motor selection',
      body: 'You selected NEMA23 for the robotic arm.',
      facts: [{ key: 'robot.motor', value: 'NEMA23' }],
    });
    let context = (await brain.context('What motor did I select for the robotic arm?')).context;
    assert.ok(context.evidence.some((e) => e.memory_id === motor1.id));
    assert.ok(context.evidence.some((e) => e.memory_id === motor2.id));
    assert.deepEqual(context.conflicts[0].values.sort(), ['NEMA17', 'NEMA23']);
    assert.equal(context.evidence.length, 2);
    const current = brain.memories.save({
      title: 'Final robot arm motor',
      body: 'The selected robotic arm motor is NEMA23.',
      facts: motor2.facts,
      supersedes: motor1.id,
    });
    brain.memories.save({ ...brain.memories.input(motor2), status: 'archived' }, motor2.id);
    brain.memories.save({
      title: 'Secret robot arm motor',
      body: 'PrivateOnlyNeedle',
      private: true,
      facts: [{ key: 'robot.motor', value: 'SECRET' }],
    });
    brain.memories.save({
      title: 'Expired robot arm motor',
      body: 'ExpiredOnlyNeedle',
      valid_from: '2020-01-01T00:00:00.000Z',
      valid_until: '2021-01-01T00:00:00.000Z',
    });
    context = (await brain.context('What motor did I select for the robotic arm?')).context;
    assert.ok(context.evidence.some((e) => e.memory_id === current.id));
    assert.equal(context.conflicts.length, 0);
    assert.ok(!context.prompt.includes('SECRET') && !context.prompt.includes('ExpiredOnlyNeedle'));
    assert.ok(!context.evidence.some((e) => e.memory_id === motor1.id || e.memory_id === motor2.id));
    // RRF/authority/graph and a weak embedding cannot qualify unrelated material.
    for (const m of [f.a, ...f.unrelated])
      brain.search.storeVector(m, [0.4, Math.sqrt(0.84)], brain.provider.fingerprint());
    brain.provider.embed = async () => [1, 0];
    brain.provider.capabilities = () => ({
      embed: true,
      generate: false,
      stream: false,
      local: true,
      model: '',
      provider: 'test',
    });
    const semantic = await brain.context('What is FORGELINE?', true);
    assert.ok(!semantic.context.evidence.some((e) => f.unrelated.some((m) => m.id === e.memory_id)));
    assert.ok(semantic.diagnostics.candidate_count > semantic.diagnostics.evidence_count);
  });
});

test('Streaming and non-streaming Ask send the same compact metadata and natural style; empty recall makes no model call', async () => {
  const root = temporary('ask-stream-quality');
  const brain = new Brain(root);
  let service: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const f = askFixture(brain);
    const requests: any[] = [];
    brain.provider.stream = async function* (request) {
      requests.push(request);
      yield 'Your AWS project is completed. [S1]';
    };
    const answer = await brain.ask('Is AWS Architecture active or completed?', true);
    assert.equal(answer.answer, 'Your AWS project is completed. [S1]');
    const saved = brain.conversations.list()[0];
    assert.deepEqual(saved.context.omitted, []);
    assert.ok(
      !JSON.stringify(saved).includes(f.hardware.id),
      'Unused candidates must not become durable evidence dependencies',
    );
    assert.equal(requests[0].system, askSystem);
    assert.match(requests[0].prompt, /"status":"completed"/);
    assert.match(requests[0].system, /untrusted data/);
    const missing = await brain.ask('What is my lunar telescope password?', true);
    assert.match(missing.answer!, /haven't recorded/);
    assert.equal(requests.length, 1);
    service = await serve(brain, { port: 0 });
    const response = await fetch(service.origin + '/api/ask/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Is AWS Architecture active or completed?', use_model: true }),
    });
    const events = (await response.text())
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((block) => ({
        event: block.match(/^event: (.+)/)![1],
        data: JSON.parse(block.match(/\ndata: (.+)/)![1]),
      }));
    assert.equal(requests[1].system, requests[0].system);
    assert.equal(events[0].data.hits, undefined, 'Candidate list is not sent to chat UI');
    assert.equal(events[0].data.context.evidence.length, 1);
    assert.equal(events[0].data.context.evidence[0].memory_id, f.b.id);
    assert.ok(events.some((e) => e.event === 'token' && e.data.text.includes('completed')));
  } finally {
    if (service) await service.close();
    else await brain.close();
    removeTemporary(root);
  }
});

test('Migration preserves legacy turns; New Chat persists a fresh scope without touching memory, events or indexes', async () => {
  const root = temporary('ask-chat-migration');
  let brain = new Brain(root);
  try {
    const memory = brain.memories.save({ title: 'Chat fixture', body: 'A durable memory.' });
    await brain.ask('Chat fixture');
    const oldId = brain.conversations.current();
    await brain.close();
    const db = new DatabaseSync(join(root, 'database/brain.db'));
    db.exec(
      'DROP INDEX ask_turns_conversation; ALTER TABLE ask_turns DROP COLUMN conversation_id; DROP TABLE ask_chat; DELETE FROM migrations WHERE version=5;',
    );
    db.close();
    brain = new Brain(root);
    assert.equal(brain.conversations.list().length, 1);
    const bytes = readFileSync(join(root, memory.path)),
      events = brain.status().events;
    const indexes = brain.storage.index.prepare('SELECT * FROM indexed ORDER BY id').all();
    const fresh = brain.conversations.newChat();
    assert.notEqual(fresh.id, oldId);
    assert.equal(brain.conversations.list(100, 0, fresh.id).length, 0);
    assert.equal(brain.conversations.list().length, 1);
    assert.deepEqual(readFileSync(join(root, memory.path)), bytes);
    assert.equal(brain.status().events, events);
    assert.deepEqual(brain.storage.index.prepare('SELECT * FROM indexed ORDER BY id').all(), indexes);
    assert.throws(
      () => brain.conversations.begin('Stale request', compileContext('fixture', []), null, oldId),
      /active chat changed/,
    );
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.conversations.current(), fresh.id);
    assert.equal(brain.conversations.list(100, 0, fresh.id).length, 0);
    await brain.ask('Chat fixture');
    brain.conversations.selectChat(oldId);
    assert.equal(brain.conversations.list(100, 0, oldId)[0].question, 'Chat fixture');
    assert.equal(brain.memories.get(memory.id).body, memory.body);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
