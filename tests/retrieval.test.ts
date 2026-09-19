import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrain } from './helpers.js';
import { parseQuery } from '../server/retrieval/search.js';
import { compileContext, citationWarning } from '../server/context/compiler.js';
import { tokens } from '../server/core/util.js';

test('Generated answers warn on missing or unavailable citations without inventing sources', () =>
  withBrain(async (brain) => {
    brain.memories.save({ title: 'Citable evidence', body: 'A known fact.' });
    const { context } = await brain.context('Citable');
    assert.equal(citationWarning('A known fact [S1].', context), '');
    assert.match(citationWarning('A fact [S999].', context), /unavailable/);
    assert.match(citationWarning('An uncited assertion.', context), /without source/);
    assert.equal(citationWarning('', context), '');
  }));
test('Search parser preserves exact phrases and quoted metadata filters', () => {
  const parsed = parseQuery(
    'project:"Home lab" type:decision "FL - Allow RDP TCP from MGMT" before:2026-10-01',
  );
  assert.equal(parsed.filters.project, 'Home lab');
  assert.equal(parsed.phrases[0], 'FL - Allow RDP TCP from MGMT');
  assert.throws(() => parseQuery('before:garbage'), /YYYY/);
});
test('Exact identifiers beat loose matches; tag, source, type and project filters work', () =>
  withBrain((brain) => {
    const exact = brain.memories.save({
      title: 'Firewall evidence',
      body: 'FL - Allow RDP TCP from MGMT',
      type: 'decision',
      project: 'FORGELINE',
      tags: ['gpo'],
    });
    brain.memories.save({
      title: 'RDP management',
      body: 'RDP RDP RDP management host rule Windows firewall.',
      importance: 1,
    });
    assert.equal(brain.search.query('FL - Allow RDP TCP from MGMT')[0].memory.id, exact.id);
    assert.equal(brain.search.query('"FL - Allow RDP TCP from MGMT"').length, 1);
    assert.equal(brain.search.query('project:forgeline type:decision tag:gpo')[0].memory.id, exact.id);
    assert.equal(brain.search.query('type:project').length, 0);
    const imported = brain.ingestion.file('evidence.txt', Buffer.from('Original policy rationale.'));
    assert.equal(brain.search.query('source:evidence.txt policy')[0].memory.id, imported.memory.id);
    assert.doesNotThrow(() => brain.search.query("' OR 1=1; DROP TABLE memories; --"));
    assert.equal(brain.status().memories, 3);
  }));
test('Entity and graph evidence contribute actual retrieval signals', () =>
  withBrain((brain) => {
    const p = brain.memories.save({ title: 'FORGELINE', type: 'project' }),
      n = brain.memories.save({
        title: 'Management boundary',
        body: 'Only the jump host may administer the domain.',
      });
    brain.graph.link({ from_id: p.id, to_id: n.id, type: 'secured_by' });
    const hit = brain.search.query('FORGELINE').find((h) => h.memory.id === n.id);
    assert.ok(hit);
    assert.ok(hit.signals.includes('graph'));
    assert.ok(hit.matched_entities.includes(p.id));
    assert.ok(brain.search.query('entity:FORGELINE').some((h) => h.memory.id === n.id));
  }));
test('Indexes can be deleted and rebuilt without touching canonical data', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'Rebuildable', body: 'unique-antifragile-index' });
    brain.storage.index.exec('DELETE FROM documents; DELETE FROM indexed; DELETE FROM chunks;');
    assert.equal(brain.search.query('unique-antifragile-index').length, 0);
    assert.equal(brain.memories.get(m.id).body, m.body);
    assert.equal(brain.search.rebuild().count, 1);
    assert.equal(brain.search.query('unique-antifragile-index')[0].memory.id, m.id);
    assert.equal(brain.memories.events.list({ aggregate: m.id }).length, 1);
  }));
test('Optional vectors fuse with lexical retrieval and mismatched models are ignored', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'Architecture note', body: 'Domain trust boundaries' });
    brain.storage.index
      .prepare('INSERT INTO vectors VALUES (?,?,?,?)')
      .run(m.id, m.content_hash, 'test-model', '[1,0,0]');
    const hits = brain.search.query('unrelated-word', { vector: [1, 0, 0], provider: 'test-model' });
    assert.equal(hits[0].memory.id, m.id);
    assert.ok(hits[0].signals.includes('semantic'));
    assert.equal(
      brain.search.query('unrelated-word', { vector: [1, 0, 0], provider: 'another-model' }).length,
      0,
    );
  }));
test('Context excludes private and superseded memory, exposes conflicts, preserves source references, and obeys UTF-8 budget', () =>
  withBrain((brain) => {
    const old = brain.memories.save({
      title: 'GPU budget old',
      body: 'GPU budget 1450 EUR',
      fact_key: 'gpu.max_price',
      fact_value: '1450 EUR',
    });
    const current = brain.memories.save({
      title: 'GPU budget current',
      body: 'GPU budget 1300 EUR',
      fact_key: 'gpu.max_price',
      fact_value: '1300 EUR',
      supersedes: old.id,
    });
    const conflict = brain.memories.save({
      title: 'GPU budget unresolved',
      body: 'GPU budget 1200 EUR',
      fact_key: 'gpu.max_price',
      fact_value: '1200 EUR',
    });
    const secret = brain.memories.save({
      title: 'GPU private account',
      body: 'GPU private identifier SECRET',
      private: true,
    });
    const package_ = compileContext('GPU budget', brain.search.query('GPU'), 2500);
    assert.ok(package_.evidence.some((e) => e.memory_id === current.id));
    assert.ok(!package_.evidence.some((e) => e.memory_id === old.id || e.memory_id === secret.id));
    assert.equal(package_.conflicts.length, 1);
    assert.equal(package_.conflicts[0].values.length, 2);
    assert.ok(package_.prompt.includes('untrusted data'));
    assert.ok(!package_.prompt.includes('SECRET'));
    assert.ok(tokens(package_.prompt) <= 2500);
    brain.memories.save({ title: 'GPU unicode', body: 'GPU ' + '漢字🙂'.repeat(3000) });
    const small = compileContext('GPU', brain.search.query('GPU'), 400);
    assert.ok(tokens(small.prompt) <= 400);
    assert.ok(small.omitted.length > 0);
  }));
test('AI-disabled Ask returns authoritative evidence and does not require a network', () =>
  withBrain(async (brain) => {
    brain.memories.save({ title: 'Offline plan', body: 'Keep the brain local.' });
    const answer = await brain.ask('brain');
    assert.equal(answer.mode, 'evidence');
    assert.equal(answer.answer, null);
    assert.equal(answer.context.evidence.length, 1);
  }));
test('Context never promotes an old fact when its superseding memory does not match the query', () =>
  withBrain(async (brain) => {
    const old = brain.memories.save({
      title: 'Obsolete identifier',
      body: 'Olduniqueidentifier value',
      fact_key: 'setting',
      fact_value: 'old',
    });
    brain.memories.save({
      title: 'Replacement',
      body: 'A new value',
      supersedes: old.id,
      fact_key: 'setting',
      fact_value: 'new',
    });
    const result = await brain.context('Olduniqueidentifier');
    assert.equal(result.context.evidence.length, 0);
    assert.ok(result.context.omitted.some((o) => o.id === old.id && o.reason === 'explicitly superseded'));
  }));
test('Doctor detects stale same-count indexes and rebuilding repairs them', () =>
  withBrain((brain) => {
    const memory = brain.memories.save({ title: 'Index health', body: 'The current revision.' });
    brain.storage.index.prepare('UPDATE indexed SET hash=? WHERE id=?').run('stale', memory.id);
    assert.equal(brain.doctor().ok, false);
    assert.equal(brain.doctor().stale, 1);
    brain.search.rebuild();
    assert.equal(brain.doctor(true).ok, true);
  }));
