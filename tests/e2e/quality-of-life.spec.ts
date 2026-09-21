import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';

test('Edit tasks in place, preserve completion shortcuts and reject conflicting edits', async ({ page }) => {
  const root = temporary('qol-tasks-ui');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  const task = brain.structured.task({ title: 'Original next step', project: 'Before' });
  const service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Edit task: Original next step' }).click();
    await page.getByLabel('Edit task content').fill('Revised next step');
    await page.getByLabel('Edit task project').fill('After');
    await page.getByLabel('Edit task due date').fill('2027-04-05');
    await page.getByLabel('Edit task status').selectOption('doing');
    await page.screenshot({ path: 'test-results/qol-task-editor.png', fullPage: true });
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Edit task', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Revised next step', exact: true })).toBeVisible();
    expect(brain.structured.tasks()).toHaveLength(1);
    expect(brain.structured.tasks()[0]).toMatchObject({
      id: task.id,
      project: 'After',
      due_at: '2027-04-05',
      status: 'doing',
      version: 2,
    });
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Revised next step', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'In progress', exact: true }).click();
    await page.getByRole('button', { name: 'Complete Revised next step', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Revised next step', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(page.getByLabel('Status of Revised next step')).toHaveValue('done');
    await page.getByRole('button', { name: 'Edit task: Revised next step' }).click();
    await page.getByLabel('Edit task due date').fill('');
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Edit task', exact: true })).toHaveCount(0);
    expect(brain.structured.tasks()[0].due_at).toBeNull();
    await page.getByRole('button', { name: 'Edit task: Revised next step' }).click();
    await page.getByLabel('Edit task content').fill('Unsaved draft');
    const { id, created_at, updated_at, version, ...data } = brain.structured.tasks()[0];
    brain.structured.task({ ...data, title: 'Concurrent edit', expected_version: version }, id as string);
    await page.getByRole('button', { name: 'Save task', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Task changed');
    await expect(page.getByLabel('Edit task content')).toHaveValue('Unsaved draft');
    await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
    await page.reload();
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Concurrent edit', exact: true })).toBeVisible();
    expect(brain.structured.tasks()).toHaveLength(1);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('Scoped views connect across the brain, combine filters, browse archives and expand complete history', async ({
  page,
}) => {
  const root = temporary('qol-memory-ui');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  const inbox = brain.memories.save({
    title: 'Inbox origin',
    status: 'inbox',
    type: 'capture',
    project: 'Workshop',
    tags: ['review'],
    memory_class: 'working',
  });
  brain.memories.save({ title: 'Inbox distraction', status: 'inbox', type: 'note' });
  const note = brain.memories.save({
    title: 'Outside decision',
    body: 'CrossScopeEvidence',
    type: 'decision',
    project: 'Workshop',
    tags: ['review'],
    memory_class: 'procedural',
  });
  const hidden = brain.memories.save({ title: 'Outside archived', status: 'archived' });
  const old = brain.memories.save({
    title: 'Retained archive',
    body: 'RetainedArchiveNeedle',
    project: 'Workshop',
    status: 'archived',
  });
  for (let i = 0; i < 82; i++) {
    const current = brain.memories.get(note.id);
    brain.memories.save({ ...brain.memories.input(current), expected_version: current.version }, note.id);
  }
  const history = brain.memories.events.list({ aggregate: note.id, limit: 100 });
  const service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    // Reproduce a graph scope that omits the desired target entirely.
    await page.route('**/api/graph?*', (route) =>
      route.fulfill({ json: { entities: [], relationships: [], clusters: [], total: 0 } }),
    );
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.getByText('Filters', { exact: true }).click();
    await page.getByLabel('Filter by project').fill('Workshop');
    await page.getByLabel('Filter by memory type').fill('capture');
    await page.getByLabel('Filter by memory class').selectOption('working');
    await page.getByLabel('Filter by tag').fill('review');
    await expect(page.locator('.inbox-item')).toHaveCount(1);
    await page.locator('.inbox-item > button').click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Add relationship', exact: true }).click();
    await page.getByLabel('Search connection targets').fill('Outside');
    await expect(page.getByLabel('Relationship target').locator('option')).toHaveCount(2);
    await page.getByLabel('Relationship target').selectOption(note.id);
    await page.getByRole('button', { name: 'Save relationship', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(brain.graph.inspect(inbox.id).relationships.some((r) => r.to_id === note.id)).toBe(true);
    expect(brain.graph.inspect(inbox.id).relationships.some((r) => r.to_id === hidden.id)).toBe(false);
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.locator('.inbox-item')).toHaveCount(2);
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByText('Filters', { exact: true }).click();
    await page.getByLabel('Filter by project').fill('Workshop');
    await page.getByLabel('Filter by memory type').fill('decision');
    await page.getByLabel('Filter by memory class').selectOption('procedural');
    await page.getByLabel('Filter by status').selectOption('active');
    await page.getByLabel('Filter by tag').fill('review');
    await page.getByLabel('Filter notes').fill('Outside');
    await expect(page.locator('.memory-row')).toHaveCount(1);
    await page.getByText('Filters (5)', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove project filter' })).toBeVisible();
    await page.screenshot({ path: 'test-results/qol-memory-filters.png', fullPage: true });
    await page.locator('.memory-row').click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Add relationship', exact: true }).click();
    await page.getByLabel('Search connection targets').fill('Inbox origin');
    await page.getByLabel('Relationship target').selectOption(inbox.id);
    await page.getByRole('button', { name: 'Save relationship', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(
      brain.graph.inspect(note.id).relationships.some((r) => r.from_id === note.id && r.to_id === inbox.id),
    ).toBe(true);
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByLabel('Filter notes').fill('');
    await expect(page.locator('.memory-row')).toHaveCount(3);
    await page.getByRole('button', { name: 'Archived', exact: true }).click();
    await expect(page.locator('.memory-row')).toHaveCount(2);
    await page.getByRole('button', { name: /Retained archive/ }).click();
    await expect(page.locator('.inspector')).toContainText('RetainedArchiveNeedle');
    await page.getByRole('button', { name: 'Restore memory', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore memory', exact: true })).toHaveCount(0);
    expect(brain.memories.get(old.id).status).toBe('active');
    expect(brain.memories.get(old.id).version).toBe(2);
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await expect(page.locator('.memory-row')).toHaveCount(1);
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    const group = page
      .locator('.timeline-group')
      .filter({ has: page.locator('summary', { hasText: 'Outside decision' }) });
    await expect(group.locator('summary')).toContainText('83 events');
    await expect(group.locator('.timeline-event')).toHaveCount(0);
    await group.locator('summary').click();
    await expect(group.locator('.timeline-event')).toHaveCount(80);
    await page.screenshot({ path: 'test-results/qol-timeline.png', fullPage: true });
    await group.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(group.locator('.timeline-event')).toHaveCount(3);
    await group.locator('.timeline-event').last().click();
    await expect(page.getByRole('dialog')).toContainText('CrossScopeEvidence');
    await page.getByText('Provenance and event identifier', { exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(history.at(-1)!.id);
    expect(brain.memories.events.list({ aggregate: note.id, limit: 100 })).toEqual(history);
    expect(brain.doctor(true).ok).toBe(true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});
