import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Brain } from '../server/app.js';
import { readMarkdown } from '../server/memory/markdown.js';
import { hash, now } from '../server/core/util.js';
import { withBrain, temporary, removeTemporary } from './helpers.js';

test('Filesystem notifications hash externally edited files even with preserved timestamps', () =>
  withBrain((brain) => {
    const memory = brain.memories.save({ title: 'Watched file', body: 'Value: one' });
    const path = join(brain.storage.root, memory.path),
      stat = statSync(path);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Value: one', 'Value: two'));
    utimesSync(path, stat.atime, stat.mtime);
    brain.memories.reconcileFile(memory.path, true);
    assert.equal(brain.memories.get(memory.id).body, 'Value: two');
    assert.equal(brain.memories.get(memory.id).provenance.kind, 'observation');
  }));

test('A second owner is rejected before opening canonical storage', () =>
  withBrain((brain) => {
    assert.throws(() => new Brain(brain.storage.root), /already open/);
    assert.equal(brain.doctor(true).ok, true);
  }));

test('Markdown, schema migrations, provenance and revision history persist across restart', async () => {
  const root = temporary('persistence');
  let brain = new Brain(root);
  try {
    const original = brain.memories.save({
      title: 'FORGELINE',
      body: '# Architecture\nDC01 and DC02.',
      type: 'project',
      tags: ['infrastructure'],
    });
    assert.ok(existsSync(join(root, original.path)));
    assert.equal(readMarkdown(readFileSync(join(root, original.path), 'utf8')).metadata.id, original.id);
    const beforeUpdate = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const updated = brain.memories.save(
      { ...brain.memories.input(original), body: '# Architecture\nDC01, DC02, and MGMT01.' },
      original.id,
    );
    assert.equal(updated.version, 2);
    assert.equal(brain.memories.get(original.id, beforeUpdate).body, original.body);
    assert.equal(brain.memories.events.list({ aggregate: original.id }).length, 2);
    assert.equal(brain.memories.get(original.id).provenance.kind, 'user');
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.memories.get(original.id).body, updated.body);
    assert.equal(brain.search.query('MGMT01')[0].memory.id, original.id);
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM migrations').get()!.n, 6);
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
test('History is append-only and stale writes fail without losing either revision', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'Decision', body: 'A' });
    brain.memories.save({ ...brain.memories.input(m), body: 'B' }, m.id);
    assert.throws(() => brain.memories.save({ ...brain.memories.input(m), body: 'C' }, m.id), /changed/);
    assert.throws(() => brain.storage.db.exec("UPDATE events SET actor='attacker'"), /append-only/);
    assert.throws(() => brain.storage.db.exec('DELETE FROM events'), /append-only/);
    assert.equal(brain.memories.get(m.id).body, 'B');
  }));
test('Committed outbox is replayed after simulated filesystem failure, preserving an external conflict', async () => {
  const root = temporary('recovery');
  let brain = new Brain(root);
  try {
    const m = brain.memories.save({ title: 'Recoverable', body: 'Original' });
    const flush = brain.memories.flush.bind(brain.memories);
    brain.memories.flush = () => {
      throw new Error('simulated disk full');
    };
    assert.throws(
      () => brain.memories.save({ ...brain.memories.input(m), body: 'Committed before crash' }, m.id),
      /disk full/,
    );
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);
    writeFileSync(join(root, m.path), '# External edit during outage');
    brain.memories.flush = flush;
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.memories.get(m.id).body, 'Committed before crash');
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 0);
    const recovery = brain.memories.events
      .list({ aggregate: m.id })
      .find((e) => e.kind === 'recovery.external_conflict');
    assert.ok(recovery);
    const source = brain.memories.objects.get(recovery.payload.source_id);
    assert.equal(
      readFileSync(brain.memories.objects.path(source.hash), 'utf8'),
      '# External edit during outage',
    );
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
test('External edits, imported frontmatter, and deletions remain auditable', () =>
  withBrain((brain) => {
    const m = brain.memories.save({ title: 'External', body: 'Before' });
    const path = join(brain.storage.root, m.path);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Before', 'After'));
    assert.throws(
      () => brain.memories.save({ ...brain.memories.input(m), body: 'Stale UI' }, m.id),
      /externally/,
    );
    assert.equal(brain.memories.reconcile().errors.length, 0);
    assert.equal(brain.memories.get(m.id).body, 'After');
    assert.equal(brain.memories.get(m.id).provenance.actor, 'filesystem');
    unlinkSync(path);
    brain.memories.reconcile();
    assert.equal(brain.memories.get(m.id).status, 'archived');
    assert.equal(brain.memories.get(m.id).body, 'After');
    writeFileSync(
      join(brain.storage.root, 'vault/new.md'),
      '---\ntitle: On disk\ntags: [external]\n---\n# Direct edit\n',
    );
    brain.memories.reconcile();
    assert.equal(brain.search.query('type:note "Direct edit"')[0].memory.title, 'On disk');
  }));
test('Original imports deduplicate by SHA-256 and unsupported files remain downloadable', () =>
  withBrain((brain) => {
    const bytes = Buffer.from('---\ntitle: Imported design\ntype: decision\n---\n# Keep the source\n');
    const imported = brain.ingestion.file('../design.md', bytes);
    assert.equal(imported.memory.type, 'decision');
    assert.equal(imported.memory.provenance.kind, 'import');
    assert.equal(imported.source.hash, hash(bytes));
    const duplicate = brain.ingestion.file('renamed.md', bytes);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.memory.id, imported.memory.id);
    assert.equal(readFileSync(brain.memories.objects.path(imported.source.hash)).compare(bytes), 0);
    const binary = brain.ingestion.file('research.pdf', Buffer.from('%PDF-original-binary'));
    assert.match(binary.memory.body, /not available/);
    assert.equal(binary.source.metadata.extracted, false);
    assert.equal(brain.memories.objects.list().length, 2);
  }));
test('Invalid YAML, aliases and out-of-range domain state fail safely', () =>
  withBrain((brain) => {
    assert.throws(() => readMarkdown('---\ntitle: A\ntitle: B\n---\nbody'), /Invalid YAML/);
    assert.throws(() => readMarkdown('---\n__proto__: evil\n---\nbody'), /Reserved/);
    assert.throws(() => readMarkdown('---\nunterminated'), /Unclosed/);
    assert.throws(() => brain.memories.save({ title: '', body: 'bad' }));
    assert.throws(
      () =>
        brain.memories.save({
          title: 'Time',
          valid_from: '2026-09-10T00:00:00.000Z',
          valid_until: '2026-09-09T00:00:00.000Z',
        }),
      /valid_until/,
    );
    assert.equal(brain.status().memories, 0);
  }));
test('Typed graph temporal state and structured tasks preserve provenance', () =>
  withBrain((brain) => {
    const a = brain.memories.save({ title: 'FORGELINE', type: 'project' });
    const b = brain.graph.entity({ name: 'DC01', type: 'device' });
    const link = brain.graph.link({ from_id: a.id, to_id: b.id, type: 'contains' });
    assert.equal(brain.graph.view().relationships.length, 1);
    assert.equal(brain.graph.link({ from_id: a.id, to_id: b.id, type: 'contains' }).id, link.id);
    assert.throws(() => brain.graph.link({ from_id: a.id, to_id: a.id, type: 'uses' }), /Self/);
    brain.graph.unlink(link.id);
    assert.equal(brain.graph.view().relationships.length, 0);
    assert.ok(brain.graph.inspect(a.id).relationships[0].valid_until);
    const task = brain.structured.task({ title: 'Validate DNS', project: 'FORGELINE' });
    brain.structured.task({ title: task.title, status: 'done', expected_version: task.version }, task.id);
    assert.equal(brain.structured.tasks()[0].status, 'done');
    assert.equal(brain.memories.events.list({ aggregate: task.id }).length, 2);
    const record = brain.structured.record({
      type: 'measurement',
      data: { metric: 'temperature', value: 23.2, unit: 'C' },
    });
    assert.equal(brain.structured.records('measurement')[0].data.value, 23.2);
  }));
test('Proposals never mutate memory before review; inference provenance survives acceptance', () =>
  withBrain((brain) => {
    const p = brain.proposals.create({
      kind: 'memory',
      payload: { title: 'Possible conclusion', body: 'Uncertain inference' },
      evidence: [],
      provenance: { kind: 'ai', actor: 'model', model: 'test-local', confidence: 0.7, evidence: [] },
    });
    assert.equal(brain.status().memories, 0);
    const accepted = brain.proposals.resolve(p.id, 'accept');
    assert.equal(brain.memories.get(accepted.result_id!).provenance.kind, 'ai');
    assert.equal(brain.memories.get(accepted.result_id!).provenance.actor, 'user-reviewed');
    assert.throws(() => brain.proposals.resolve(p.id, 'accept'), /already/);
    const rejected = brain.proposals.create({
      kind: 'memory',
      payload: { title: 'Never accepted' },
      provenance: { kind: 'software', actor: 'test', evidence: [] },
    });
    brain.proposals.resolve(rejected.id, 'reject');
    assert.equal(brain.status().memories, 1);
  }));
test('Incremental consolidation proposes only real unambiguous references', () =>
  withBrain((brain) => {
    const project = brain.memories.save({ title: 'FORGELINE', type: 'project' });
    const note = brain.memories.save({ title: 'RDP', body: 'See [[FORGELINE]] and [[Not invented]].' });
    const result = brain.proposals.consolidate();
    assert.equal(result.proposals, 1);
    assert.ok(result.issues.some((i) => i.kind === 'unresolved-link'));
    assert.equal(brain.graph.view().relationships.length, 0);
    brain.proposals.resolve(brain.proposals.list()[0].id, 'accept');
    assert.equal(brain.graph.view().relationships.length, 1);
    assert.equal(brain.proposals.consolidate().processed, 0);
  }));

test('Memory update proposals retain history and reject changes against stale revisions', () =>
  withBrain((brain) => {
    const memory = brain.memories.save({ title: 'Project phase', body: 'Phase 2' });
    const provenance = { kind: 'ai', actor: 'test-model', evidence: [memory.id] };
    const suggestion = brain.proposals.create({
      kind: 'memory',
      payload: { memory_id: memory.id, expected_version: 1, body: 'Phase 3' },
      provenance,
    });
    assert.equal(brain.memories.get(memory.id).body, 'Phase 2');
    brain.proposals.resolve(suggestion.id, 'accept');
    assert.equal(brain.memories.get(memory.id).body, 'Phase 3');
    assert.equal(brain.memories.get(memory.id).version, 2);
    assert.equal(brain.memories.get(memory.id).provenance.kind, 'ai');
    const stale = brain.proposals.create({
      kind: 'memory',
      payload: { memory_id: memory.id, expected_version: 1, body: 'Stale phase' },
      provenance,
    });
    assert.throws(() => brain.proposals.resolve(stale.id, 'accept'), /changed/);
    assert.equal(brain.proposals.list()[0].status, 'pending');
  }));
test('Ask history and selected source revisions survive restart without becoming confirmed memory', async () => {
  const root = temporary('conversation');
  let brain = new Brain(root);
  try {
    brain.memories.save({ title: 'Evidence for chat', body: 'A recorded decision.' });
    await brain.ask('decision');
    const turns = brain.conversations.list();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].status, 'complete');
    assert.equal(turns[0].evidence[0].version, 1);
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.conversations.list()[0].question, 'decision');
    assert.equal(brain.status().memories, 1);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
