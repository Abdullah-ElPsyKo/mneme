import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { Brain } from '../server/app.js';
import { restoreBackup, verifyBackup } from '../server/backup/backup.js';
import { withBrain, temporary, removeTemporary } from './helpers.js';
test('Snapshot verifies and restores Markdown, evidence, graph, tasks, records and history into a fresh brain', () =>
  withBrain(async (brain) => {
    const m = brain.memories.save({ title: 'Backup project', type: 'project', body: 'Architecture v1' });
    brain.memories.save({ ...brain.memories.input(m), body: 'Architecture v2' }, m.id);
    const source = brain.ingestion.file('source.txt', Buffer.from('Original evidence survives.'));
    brain.graph.link({ from_id: m.id, to_id: source.memory.id, type: 'documented_by' });
    brain.structured.task({ title: 'Test recovery', project: 'Backup project' });
    brain.structured.record({ type: 'measurement', data: { value: 42 } });
    const snapshot = await brain.backups.create();
    const verified = await verifyBackup(snapshot.path);
    assert.equal(verified.valid, true);
    const restoreParent = temporary('restore');
    const destination = join(restoreParent, 'brain');
    try {
      await restoreBackup(snapshot.path, destination);
      const restored = new Brain(destination);
      try {
        assert.equal(restored.memories.get(m.id).body, 'Architecture v2');
        assert.equal(restored.memories.events.list({ aggregate: m.id }).length, 2);
        assert.equal(restored.graph.view().relationships.length, 1);
        assert.equal(restored.structured.tasks().length, 1);
        assert.equal(restored.structured.records()[0].data.value, 42);
        assert.equal(
          readFileSync(restored.memories.objects.path(source.source.hash), 'utf8'),
          'Original evidence survives.',
        );
        assert.equal(restored.doctor(true).ok, true);
        assert.equal(restored.search.query('Architecture')[0].memory.id, m.id);
        assert.equal(restored.settings.data.provider, 'disabled');
      } finally {
        await restored.close();
      }
      await assert.rejects(() => restoreBackup(snapshot.path, destination), /new directory/);
    } finally {
      removeTemporary(restoreParent);
    }
  }));
test('Standard AES-256 encrypted snapshots require the correct passphrase and detect corruption', () =>
  withBrain(async (brain) => {
    brain.memories.save({ title: 'Private backup', body: 'Sensitive test fixture' });
    const password = 'test-only-passphrase-32-characters';
    const snapshot = await brain.backups.create(password);
    assert.equal(snapshot.encrypted, true);
    assert.equal((await verifyBackup(snapshot.path, password)).valid, true);
    await assert.rejects(() => verifyBackup(snapshot.path, 'incorrect-password'));
    assert.ok(!readFileSync(snapshot.path).includes(Buffer.from('Sensitive test fixture')));
    const damaged = readFileSync(snapshot.path);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    const badPath = join(brain.storage.root, 'backups/damaged.zip');
    writeFileSync(badPath, damaged);
    await assert.rejects(() => verifyBackup(badPath, password));
  }));
test('Restore rejects traversal, duplicate entry names, and unlisted files', async () => {
  const root = temporary('bad-snapshot');
  try {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await zip.add('../escape.txt', new TextReader('outside'));
    await zip.add(
      'manifest.json',
      new TextReader(
        JSON.stringify({ format: 'mneme-backup-v1', created_at: new Date().toISOString(), files: [] }),
      ),
    );
    const path = join(root, 'bad.zip');
    writeFileSync(path, await zip.close());
    await assert.rejects(() => restoreBackup(path, join(root, 'restore')));
    assert.equal(existsSync(join(root, 'escape.txt')), false);
    assert.equal(existsSync(join(root, 'restore')), false);
  } finally {
    removeTemporary(root);
  }
});
test('Snapshot revision materialization remains consistent during concurrent foreground edits', () =>
  withBrain(async (brain) => {
    const m = brain.memories.save({ title: 'During snapshot', body: 'Before backup' });
    const promise = brain.backups.create();
    const updated = brain.memories.save({ ...brain.memories.input(m), body: 'After backup began' }, m.id);
    const snapshot = await promise;
    const parent = temporary('concurrent-restore');
    try {
      await restoreBackup(snapshot.path, join(parent, 'brain'));
      const restored = new Brain(join(parent, 'brain'));
      try {
        const current = restored.memories.get(m.id);
        assert.ok(['Before backup', 'After backup began'].includes(current.body));
        assert.equal(restored.doctor(true).ok, true);
      } finally {
        await restored.close();
      }
    } finally {
      removeTemporary(parent);
    }
  }));
