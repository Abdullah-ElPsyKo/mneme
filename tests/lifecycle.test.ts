import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../server/app.js';
import { compileContext } from '../server/context/compiler.js';
import { restoreBackup } from '../server/backup/backup.js';
import { hash } from '../server/core/util.js';
import { temporary, removeTemporary, withBrain } from './helpers.js';

const purge = (brain: Brain, id: string) =>
  brain.deletion.permanent(id, {
    confirmed: true,
    expected_revision: brain.deletion.permanentPreview(id).revision,
  });

test('Permanent deletion rejects active work and stale confirmation; new backups retain erasure markers', async () => {
  await withBrain(async (brain) => {
    let memory = brain.memories.save({ title: 'Backup erasure fixture', body: 'BackupPrivateNeedle' });
    const original = readFileSync(join(brain.storage.root, memory.path));
    const pending = brain.backups.create();
    assert.throws(() => purge(brain, memory.id), /Wait for background work/);
    const oldBackup = await pending;
    const oldHash = hash(readFileSync(oldBackup.path));
    brain.jobs.running = true;
    assert.throws(() => purge(brain, memory.id), /Wait for background work/);
    brain.jobs.running = false;
    const stale = brain.deletion.permanentPreview(memory.id).revision;
    memory = brain.memories.save(
      { ...brain.memories.input(memory), facts: [{ key: 'value', value: '2' }] },
      memory.id,
    );
    assert.throws(
      () => brain.deletion.permanent(memory.id, { confirmed: true, expected_revision: stale }),
      /changed/,
    );
    purge(brain, memory.id);
    assert.equal(hash(readFileSync(oldBackup.path)), oldHash);
    const clean = await brain.backups.create();
    const destination = join(brain.storage.root, 'restored-after-erasure');
    await restoreBackup(clean.path, destination);
    const restored = new Brain(destination);
    try {
      assert.throws(() => restored.memories.get(memory.id), /not found/);
      writeFileSync(join(destination, 'vault/stale.md'), original);
      restored.memories.reconcile(true);
      assert.equal(existsSync(join(destination, 'vault/stale.md')), false);
      assert.equal(restored.doctor(true).ok, true);
    } finally {
      await restored.close();
    }
  });
});

test('Four facts persist, migrate legacy values, and retain revision and conflict semantics', async () => {
  const root = temporary('facts-lifecycle');
  let brain = new Brain(root);
  try {
    const legacy = brain.memories.save({
      title: 'Legacy robotics',
      body: 'Legacy joint',
      fact_key: 'torque',
      fact_value: '1 Nm',
    });
    await brain.close();
    const db = new DatabaseSync(join(root, 'database/brain.db'));
    db.exec(
      'DROP INDEX memories_project_state; ALTER TABLE memories DROP COLUMN project_state; DROP INDEX ask_turns_conversation; ALTER TABLE ask_turns DROP COLUMN conversation_id; DROP TABLE ask_chat; ALTER TABLE memories DROP COLUMN facts; DROP TABLE erased_fingerprints; DROP TABLE erasure_cleanup; DELETE FROM migrations WHERE version>=4;',
    );
    db.close();
    brain = new Brain(root);
    assert.deepEqual(brain.memories.get(legacy.id).facts, [{ key: 'torque', value: '1 Nm' }]);
    const facts = ['torque', 'max', 'temperature', 'gain'].map((key, i) => ({
      key,
      value: `${i + 1} units`,
    }));
    let memory = brain.memories.save({
      title: 'Robotics testing',
      body: 'Joint 2 testing completed.',
      facts,
    });
    const originalTime = new Date().toISOString();
    await brain.close();
    brain = new Brain(root);
    assert.deepEqual(brain.memories.get(memory.id).facts, facts);
    await new Promise((r) => setTimeout(r, 5));
    const edited = [{ ...facts[0], value: '5 Nm' }, ...facts.slice(2), { key: 'speed', value: '2 rpm' }];
    memory = brain.memories.save(
      { ...brain.memories.input(brain.memories.get(memory.id)), facts: edited },
      memory.id,
    );
    assert.deepEqual(brain.memories.get(memory.id).facts, edited);
    assert.deepEqual(brain.memories.get(memory.id, originalTime).facts, facts);
    assert.equal(memory.version, 2);
    assert.throws(
      () =>
        brain.memories.save(
          {
            ...brain.memories.input(memory),
            facts: Array.from({ length: 10 }, (_, i) => ({ key: `large${i}`, value: 'x'.repeat(10000) })),
          },
          memory.id,
        ),
      /frontmatter limit/,
    );
    assert.equal(brain.memories.get(memory.id).version, 2);
    const other = brain.memories.save({
      title: 'Conflicting gain',
      body: 'Another measurement',
      facts: [{ key: 'gain', value: '0.65' }],
    });
    const result = compileContext(
      'joint',
      [legacy, memory, other].map((memory) => ({
        memory,
        score: 1,
        signals: [],
        excerpt: memory.body,
        matched_entities: [],
      })),
    );
    assert.deepEqual(result.conflicts[0].values, ['1 Nm', '5 Nm']);
    assert.equal(result.evidence[1].facts?.length, 4);
    assert.equal(result.conflicts[1].fact_key, 'gain');
    const issues = brain.proposals.consolidate().issues;
    assert.ok(issues.some((i: any) => i.fact_key === 'torque'));
    assert.ok(issues.some((i: any) => i.fact_key === 'gain'));
    memory = brain.memories.save({ ...brain.memories.input(memory), facts: [] }, memory.id);
    assert.equal(memory.fact_key, '');
    assert.deepEqual(memory.facts, []);
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Permanent erasure clears history, dependent data, exclusive objects, indices and stale copies across restart', async () => {
  const root = temporary('permanent-lifecycle');
  let brain = new Brain(root);
  try {
    const imported = brain.ingestion.file('erase.txt', Buffer.from('EraseSensitiveNeedle content'));
    let memory = brain.memories.save(
      {
        ...brain.memories.input(imported.memory),
        status: 'active',
        facts: [{ key: 'private.fact', value: 'EraseSensitiveFact' }],
      },
      imported.memory.id,
    );
    const original = readFileSync(join(root, memory.path));
    writeFileSync(join(root, 'vault/stale-copy.md'), original);
    writeFileSync(join(root, memory.path + '.abandoned.tmp'), original);
    writeFileSync(
      brain.memories.objects.path(imported.source.hash) + '.abandoned.tmp',
      Buffer.from('EraseSensitiveNeedle partial'),
    );
    const keep = brain.memories.save({
      title: 'Keep surviving memory',
      body: 'Survivor',
      supersedes: memory.id,
    });
    const edge = brain.graph.link({ from_id: memory.id, to_id: keep.id, type: 'references' });
    brain.structured.task({ title: 'Owned task', memory_id: memory.id });
    brain.proposals.create({
      kind: 'memory',
      payload: { title: 'Quoted EraseSensitiveNeedle', body: memory.body },
      evidence: [memory.id],
      provenance: { kind: 'user', actor: 'user', evidence: [memory.id] },
    });
    const context = compileContext('EraseSensitiveNeedle', [
      { memory, score: 1, signals: [], excerpt: memory.body, matched_entities: [] },
    ]);
    const turn = brain.conversations.begin('Private question', context, null);
    brain.conversations.finish(turn.id, 'EraseSensitiveNeedle quoted answer');
    brain.jobs.enqueue('embed', { memory_id: memory.id });
    brain.search.storeVector(memory, [1, 0], 'fixture');
    const before = new Date().toISOString();
    const revision = brain.deletion.permanentPreview(memory.id).revision;
    assert.throws(() => brain.deletion.permanent(memory.id, { expected_revision: revision }), /confirmed/);
    purge(brain, memory.id);
    assert.throws(() => brain.memories.get(memory.id), /not found/);
    assert.throws(() => brain.memories.get(memory.id, before), /did not exist/);
    assert.equal(brain.memories.events.list({ aggregate: memory.id }).length, 0);
    assert.equal(brain.memories.get(keep.id).supersedes, null);
    assert.equal(brain.memories.get(keep.id, before).supersedes, null);
    assert.equal(
      brain.graph.view({ at: before }).relationships.some((r) => r.id === edge.id),
      false,
    );
    assert.equal(brain.conversations.list().length, 0);
    assert.equal(brain.proposals.list().length, 0);
    assert.equal(brain.structured.tasks().length, 0);
    assert.equal(brain.jobs.list().length, 0);
    assert.equal(existsSync(brain.memories.objects.path(imported.source.hash)), false);
    assert.equal(existsSync(join(root, 'vault/stale-copy.md')), false);
    assert.equal(existsSync(join(root, memory.path + '.abandoned.tmp')), false);
    assert.equal(existsSync(brain.memories.objects.path(imported.source.hash) + '.abandoned.tmp'), false);
    assert.throws(() => brain.conversations.begin('Stale context', context, null), /evidence was erased/);
    brain.search.storeVector(memory, [1, 0], 'fixture');
    assert.equal(brain.storage.index.prepare('SELECT count(*) AS n FROM vectors').get()!.n, 0);
    assert.throws(() => brain.storage.db.exec('DELETE FROM events'), /append-only/);
    for (const file of [
      'database/brain.db',
      'database/brain.db-wal',
      'indexes/search.db',
      'indexes/search.db-wal',
    ]) {
      if (existsSync(join(root, file))) {
        const bytes = readFileSync(join(root, file));
        assert.equal(bytes.includes(Buffer.from('EraseSensitiveNeedle')), false, file);
        assert.equal(bytes.includes(Buffer.from('EraseSensitiveFact')), false, file);
      }
    }
    await brain.close();
    brain = new Brain(root);
    writeFileSync(join(root, 'vault/renamed.md'), original);
    brain.memories.reconcile(true);
    brain.search.rebuild();
    assert.equal(existsSync(join(root, 'vault/renamed.md')), false);
    assert.equal(brain.search.query('EraseSensitiveNeedle').length, 0);
    assert.equal((await brain.context('EraseSensitiveNeedle')).context.evidence.length, 0);
    assert.equal(
      brain.graph.view({ at: before }).entities.some((e) => e.id === memory.id),
      false,
    );
    assert.throws(
      () => brain.ingestion.file('erase.txt', Buffer.from('EraseSensitiveNeedle content')),
      /permanently erased/,
    );
    assert.equal(brain.doctor(true).ok, true, JSON.stringify(brain.doctor(true)));
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Shared originals and unrelated memories survive; supersession and recovery references are cleared', async () => {
  await withBrain(async (brain) => {
    const imported = brain.ingestion.file('shared.txt', Buffer.from('Shared evidence'));
    const shared = brain.memories.save({
      title: 'Independent citation',
      body: 'Keep evidence',
      provenance: { kind: 'user', source_id: imported.source.id, evidence: [imported.source.id] },
    });
    const recovered = brain.memories.objects.put(
      `recovered-${imported.memory.id}.md`,
      Buffer.from('Exclusive recovery needle'),
      'text/markdown',
      { recovery: true },
    );
    brain.memories.events.append(
      'recovery.external_conflict',
      imported.memory.id,
      { source_id: recovered.id },
      { kind: 'software', actor: 'recovery', evidence: [recovered.id] },
    );
    purge(brain, imported.memory.id);
    assert.equal(existsSync(brain.memories.objects.path(imported.source.hash)), true);
    assert.equal(brain.memories.objects.get(imported.source.id).memory_id, null);
    assert.equal(brain.memories.get(shared.id).provenance.source_id, imported.source.id);
    assert.equal(existsSync(brain.memories.objects.path(recovered.hash)), false);
    assert.equal(brain.doctor(true).ok, true);
  });
});

test('Transactional failure restores append-only guards and content; filesystem failure resumes cleanup on restart', async () => {
  const root = temporary('permanent-failure');
  let brain = new Brain(root);
  try {
    const memory = brain.memories.save({ title: 'Delete failure fixture', body: 'FailurePrivateNeedle' });
    brain.storage.db.exec(
      "CREATE TRIGGER fail_erasure BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    assert.throws(() => purge(brain, memory.id), /injected failure/);
    assert.equal(brain.memories.get(memory.id).body, memory.body);
    assert.throws(() => brain.storage.db.exec('DELETE FROM events'), /append-only/);
    assert.equal(brain.storage.db.prepare('SELECT count(*) AS n FROM erased_fingerprints').get()!.n, 0);
    brain.storage.db.exec('DROP TRIGGER fail_erasure');
    // A directory at an expected file path produces a deterministic cleanup failure on all platforms.
    const blocked = join(root, 'vault/blocked.md');
    mkdirSync(blocked);
    brain.storage.db.prepare('UPDATE memories SET path=? WHERE id=?').run('vault/blocked.md', memory.id);
    // Get canonical content through the pending outbox, avoiding reading the injected directory.
    brain.storage.db
      .prepare('INSERT INTO outbox VALUES (?,?,?,?)')
      .run(memory.id, readFileSync(join(root, memory.path), 'utf8'), memory.content_hash, memory.updated_at);
    assert.throws(() => purge(brain, memory.id), /cleanup is incomplete/);
    assert.ok(brain.storage.db.prepare('SELECT 1 FROM erasure_cleanup').get());
    assert.throws(() => brain.memories.save({ title: 'Blocked until cleanup' }), /cleanup is pending/);
    rmdirSync(blocked);
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.storage.db.prepare('SELECT 1 FROM erasure_cleanup').get(), undefined);
    assert.throws(() => brain.memories.get(memory.id), /not found/);
    assert.equal(brain.search.query('FailurePrivateNeedle').length, 0);
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
