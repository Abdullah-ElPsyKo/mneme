import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';

test('Deletion confirmation cancels safely; editor deletion clears current UI and stays deleted after restart', async ({
  page,
}) => {
  const root = temporary('delete-ui');
  let brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  let service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'New memory', exact: true }).click();
    await page.getByLabel('Memory title').fill('Disposable UI deletion');
    await page.getByLabel('Memory content').fill('DeletionUiNeedle');
    await page.getByRole('button', { name: 'Save memory' }).click();
    await expect(page.getByRole('heading', { name: 'Disposable UI deletion', exact: true })).toBeVisible();
    const m = brain.memories.list()[0];
    const count = brain.status().events;
    await page.getByRole('button', { name: 'Delete Disposable UI deletion', exact: true }).click();
    await expect(page.getByText(/Remove this memory from current views/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(brain.memories.get(m.id).status).toBe('active');
    expect(brain.status().events).toBe(count);
    await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete Disposable UI deletion', exact: true })
      .click();
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByLabel('Search memories').fill('DeletionUiNeedle');
    await expect(page.getByText('No matching memories', { exact: true })).toBeVisible();
    expect(brain.doctor(true).ok).toBe(true);
    await page.goto('about:blank');
    await service.close();
    brain = new Brain(root);
    service = await serve(brain, { port: 0 });
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Disposable UI deletion', exact: true })).toHaveCount(0);
    expect(brain.search.query('DeletionUiNeedle')).toHaveLength(0);
    expect(brain.memories.get(m.id).status).toBe('archived');
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('Task, source, structured record and Ask deletion controls use the shared confirmation', async ({
  page,
}) => {
  const root = temporary('delete-ui-types');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  brain.structured.task({ title: 'Disposable task' });
  const imported = brain.ingestion.file('disposable-evidence.txt', Buffer.from('Evidence remains immutable'));
  const record = brain.structured.record({ type: 'measurement', data: { value: 9 } });
  await brain.ask('Evidence', false);
  const service = await serve(brain, { port: 0 });
  const confirm = async (title: string) => {
    await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
  };
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await confirm('Disposable task');
    await expect(page.getByRole('heading', { name: 'Disposable task', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sources', exact: true }).click();
    await confirm('disposable-evidence.txt');
    await expect(page.getByRole('heading', { name: 'disposable-evidence.txt', exact: true })).toHaveCount(0);
    expect(brain.memories.get(imported.memory.id).status).toBe('inbox');
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    await page.getByRole('button', { name: /RECORD CREATED/i }).click();
    await confirm('measurement record');
    expect(brain.structured.records().some((r) => r.id === record.id)).toBe(false);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await confirm('Evidence');
    await expect(page.getByRole('heading', { name: 'Evidence', exact: true })).toHaveCount(0);
    expect(brain.conversations.list()).toHaveLength(0);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('Entity, relationship and pending suggestion removal use reviewed confirmations', async ({ page }) => {
  const root = temporary('delete-ui-graph');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  const a = brain.graph.entity({ name: 'Disposable device', type: 'device' });
  const b = brain.graph.entity({ name: 'Kept device', type: 'device' });
  brain.graph.link({ from_id: a.id, to_id: b.id, type: 'uses' });
  brain.proposals.create({
    kind: 'memory',
    payload: { title: 'Disposable suggestion' },
    provenance: { kind: 'user', actor: 'user', evidence: [] },
  });
  const service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Entity list', exact: true }).click();
    await page
      .locator('.graph-accessible-list')
      .getByRole('button', { name: 'Disposable device device', exact: true })
      .click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page
      .getByRole('button', { name: 'Delete uses: Disposable device → Kept device', exact: true })
      .click();
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    await expect.poll(() => brain.graph.view().relationships.length).toBe(0);
    await page.getByRole('button', { name: 'Delete Disposable device', exact: true }).click();
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    await expect.poll(() => brain.graph.view().entities.length).toBe(1);
    await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    await page.getByRole('button', { name: /Proposals/ }).click();
    await page.getByRole('button', { name: 'Delete Disposable suggestion', exact: true }).click();
    await page.getByRole('button', { name: 'Delete item', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Disposable suggestion', exact: true })).toHaveCount(0);
    expect(brain.proposals.list('rejected')).toHaveLength(1);
    expect(brain.doctor(true).ok).toBe(true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});
