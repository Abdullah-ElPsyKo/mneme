import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../server/app.js';
import { projectStates } from '../server/core/types.js';
import { hash } from '../server/core/util.js';
import { writeMarkdown } from '../server/memory/markdown.js';
import { restoreBackup } from '../server/backup/backup.js';
import { temporary, removeTemporary, withBrain } from './helpers.js';

test('Schema 5 projects gain conservative lifecycle states without rewriting Markdown, events or associations', async () => {
  const root = temporary('legacy-projects');
  let brain = new Brain(root);
  try {
    const active = brain.memories.save({ title: 'Existing active', type: 'project', status: 'active' });
    const completed = brain.memories.save({
      title: 'Existing completed',
      type: 'project',
      status: 'completed',
    });
    const inbox = brain.memories.save({ title: 'Unsorted project', type: 'project', status: 'inbox' });
    const archived = brain.memories.save({
      title: 'Archived completion',
      type: 'project',
      status: 'completed',
    });
    brain.memories.save({ ...brain.memories.input(archived), status: 'archived' }, archived.id);
    const unknown = brain.memories.save({
      title: 'Archive without earlier state',
      type: 'project',
      status: 'archived',
    });
    const note = brain.memories.save({ title: 'Associated note', project: active.title, status: 'inbox' });
    const paths = brain.memories.list({ includeArchived: true }).map((m) => m.path);
    await brain.close();
    // Construct a real pre-lifecycle fixture: no column and no lifecycle property in canonical revisions.
    const db = new DatabaseSync(join(root, 'database/brain.db'));
    db.exec(
      'DROP TRIGGER events_no_update; DROP INDEX memories_project_state; ALTER TABLE memories DROP COLUMN project_state; DELETE FROM migrations WHERE version=6;',
    );
    for (const row of db
      .prepare("SELECT id,payload FROM events WHERE kind LIKE 'memory.%' ORDER BY seq")
      .all()) {
      const payload = JSON.parse(String(row.payload));
      delete payload.memory.project_state;
      const text = writeMarkdown(payload.memory);
      payload.memory.content_hash = hash(text);
      db.prepare('UPDATE events SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id!);
      db.prepare('UPDATE memories SET content_hash=? WHERE id=?').run(
        payload.memory.content_hash,
        payload.memory.id,
      );
      writeFileSync(join(root, payload.memory.path), text);
    }
    db.exec(
      "CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;",
    );
    const events = db.prepare('SELECT * FROM events ORDER BY seq').all();
    const bytes = paths.map((path) => readFileSync(join(root, path)));
    db.close();
    brain = new Brain(root);
    for (const [id, state] of [
      [active.id, 'active'],
      [completed.id, 'completed'],
      [inbox.id, 'planned'],
      [archived.id, 'completed'],
      [unknown.id, 'planned'],
    ])
      assert.equal(brain.memories.get(id).project_state, state);
    assert.equal(brain.memories.get(note.id).project_state, null);
    assert.equal(brain.memories.get(note.id).project, active.title);
    assert.equal(brain.memories.get(note.id).status, 'inbox');
    assert.equal(brain.memories.get(archived.id).status, 'archived');
    assert.deepEqual(brain.storage.db.prepare('SELECT * FROM events ORDER BY seq').all(), events);
    paths.forEach((path, i) => assert.deepEqual(readFileSync(join(root, path)), bytes[i]));
    assert.equal(brain.memories.get(active.id).version, 1);
    assert.equal(brain.doctor(true).ok, true);
    await brain.close();
    brain = new Brain(root);
    assert.equal(brain.memories.get(archived.id).project_state, 'completed');
    assert.deepEqual(brain.storage.db.prepare('SELECT * FROM events ORDER BY seq').all(), events);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});

test('Lifecycle edits retain project identity, associated memories, provenance and history through archive and backup', async () =>
  withBrain(async (brain) => {
    let project = brain.memories.save({ title: 'Roadmap project', type: 'project', body: 'LifecycleNeedle' });
    assert.equal(project.project_state, 'planned');
    const note = brain.memories.save({
      title: 'Related working note',
      project: project.title,
      status: 'inbox',
      private: true,
    });
    const task = brain.structured.task({
      title: 'Related task',
      project: project.title,
      memory_id: project.id,
    });
    const noteBytes = readFileSync(join(brain.storage.root, note.path));
    const noteHistory = brain.memories.events.list({ aggregate: note.id });
    const firstEvent = brain.memories.events.list({ aggregate: project.id })[0];
    for (const state of projectStates.slice(1)) {
      const previous = project;
      project = brain.memories.save({ ...brain.memories.input(project), project_state: state }, project.id);
      assert.equal(project.id, previous.id);
      assert.equal(project.version, previous.version + 1);
      assert.equal(project.status, previous.status);
      assert.deepEqual(project.provenance, previous.provenance);
      assert.throws(
        () => brain.memories.save({ ...brain.memories.input(previous), project_state: 'active' }, project.id),
        /changed/,
      );
      assert.deepEqual(
        brain.memories.list({ type: 'project', project_state: state }).map((m) => m.id),
        [project.id],
      );
      assert.equal(brain.search.query(`LifecycleNeedle project_state:${state}`)[0].memory.id, project.id);
    }
    assert.deepEqual(brain.memories.get(note.id), note);
    assert.deepEqual(brain.structured.tasks()[0], task);
    assert.deepEqual(readFileSync(join(brain.storage.root, note.path)), noteBytes);
    assert.deepEqual(brain.memories.events.list({ aggregate: note.id }), noteHistory);
    assert.deepEqual(brain.memories.events.list({ aggregate: project.id }).at(-1), firstEvent);
    assert.equal(brain.memories.get(project.id, firstEvent.at).project_state, 'planned');
    assert.throws(() =>
      brain.memories.save({ title: 'Invalid state', type: 'project', project_state: 'unknown' as any }),
    );
    assert.throws(() => brain.memories.save({ title: 'Invalid note', project_state: 'active' }));
    brain.deletion.remove('memories', project.id, {
      confirmed: true,
      expected_revision: brain.deletion.preview('memories', project.id).revision,
    });
    const archived = brain.memories.get(project.id);
    assert.equal(archived.project_state, 'abandoned');
    assert.equal(brain.search.query('LifecycleNeedle').length, 0);
    project = brain.memories.save({ ...brain.memories.input(archived), status: 'active' }, project.id);
    assert.equal(project.project_state, 'abandoned');
    assert.equal(brain.search.query('LifecycleNeedle')[0].memory.project_state, 'abandoned');
    const snapshot = await brain.backups.create();
    const parent = temporary('lifecycle-restored');
    try {
      await restoreBackup(snapshot.path, join(parent, 'brain'));
      const restored = new Brain(join(parent, 'brain'));
      try {
        assert.equal(restored.memories.get(project.id).project_state, 'abandoned');
        assert.deepEqual(
          restored.memories.events.list({ aggregate: project.id }),
          brain.memories.events.list({ aggregate: project.id }),
        );
        assert.deepEqual(restored.memories.get(note.id), note);
        assert.equal(restored.doctor(true).ok, true);
      } finally {
        await restored.close();
      }
    } finally {
      removeTemporary(parent);
    }
  }));

test('Ask uses project lifecycle instead of visibility or stale prose when describing current work', async () =>
  withBrain(async (brain) => {
    const projects = projectStates.map((state) =>
      brain.memories.save({
        title: `${state} example`,
        type: 'project',
        project_state: state,
        body: 'Currently active work. Older planning notes.',
        facts: [{ key: 'shared.claim', value: state }],
      }),
    );
    const active = await brain.context('What projects am I actively working on?');
    assert.deepEqual(
      active.context.evidence.map((e) => e.memory_id),
      [projects[1].id],
    );
    for (const state of projectStates) {
      const result = await brain.context(`Which projects are ${state}?`);
      assert.deepEqual(
        result.context.evidence.map((e) => e.project_state),
        [state],
      );
      assert.equal(result.context.evidence[0].status, state);
    }
    const all = await brain.context('List all projects');
    assert.deepEqual(new Set(all.context.evidence.map((e) => e.project_state)), new Set(projectStates));
    const planned = await brain.context('What is planned example?');
    assert.equal(planned.context.evidence.find((e) => e.memory_id === projects[0].id)?.status, 'planned');
  }));
