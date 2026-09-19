import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';
test.describe.configure({ mode: 'serial' });
let root: string, brain: Brain, service: Awaited<ReturnType<typeof serve>>, noteId: string;
test.beforeAll(async () => {
  root = temporary('e2e');
  brain = new Brain(root);
  service = await serve(brain, { port: 0 });
  mkdirSync('artifacts/screenshots', { recursive: true });
});
test.afterAll(async () => {
  await service.close();
  removeTemporary(root);
});
test.beforeEach(async ({ page }) => {
  await page.goto(service.url);
  await expect(page.getByRole('button', { name: 'Mneme home' })).toBeVisible();
});

test('Create brain, write Markdown, inspect provenance, edit, and read history', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(service.origin)) remoteRequests.push(request.url());
  });
  await expect(page.getByRole('heading', { name: 'Welcome to Mneme' })).toBeVisible();
  await page.getByLabel('Brain name').fill('Workflow verification');
  await page.getByRole('button', { name: 'Open my brain' }).click();
  await expect(page.getByRole('heading', { name: /It starts with/ })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/01-empty-brain.png' });
  await page.getByRole('button', { name: 'New memory', exact: true }).click();
  await page.getByLabel('Memory title').fill('FORGELINE access decision');
  await page
    .getByLabel('Memory content')
    .fill(
      '# RDP boundary\n\nFL - Allow RDP TCP from MGMT\n\nAdministrative RDP originates from **MGMT01**.\n\n<script>alert("unsafe")</script><img src="https://evil.invalid/leak" onerror="alert(1)">',
    );
  await page.getByLabel('Memory type', { exact: true }).selectOption('decision');
  await page.getByLabel('Project', { exact: true }).fill('FORGELINE');
  await page.getByLabel('Tags', { exact: true }).fill('rdp, infrastructure');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByRole('heading', { name: 'FORGELINE access decision' })).toBeVisible();
  await expect(page.locator('.markdown script, .markdown img')).toHaveCount(0);
  expect(remoteRequests).toEqual([]);
  await page.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.getByText('Recorded provenance')).toBeVisible();
  await expect(page.getByText('Canonical file')).toBeVisible();
  noteId = brain.memories.list().find((m) => m.title === 'FORGELINE access decision')!.id;
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/02-inspector.png' });
  await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
  await page
    .getByLabel('Memory content')
    .fill(
      '# RDP boundary\n\nFL - Allow RDP TCP from MGMT\n\nAdministrative RDP originates from **MGMT01**.\n\nRationale: reduce the management attack surface.',
    );
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.editor-preview strong')).toHaveText('MGMT01');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/03-editor.png' });
  await page.getByRole('button', { name: 'Save memory' }).click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('user · revision 2')).toBeVisible();
  expect(brain.memories.events.list({ aggregate: noteId }).length).toBe(2);
});
test('Search exact identifiers and filters, use command palette, and capture quickly', async ({ page }) => {
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page
    .getByLabel('Search memories')
    .fill('project:FORGELINE type:decision "FL - Allow RDP TCP from MGMT"');
  await expect(page.getByRole('heading', { name: 'FORGELINE access decision' })).toBeVisible();
  await expect(page.getByText('exact text', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/04-search.png' });
  await page.keyboard.press('Control+k');
  await page.getByLabel('Command search').fill('FORGELINE');
  await expect(page.getByRole('option', { name: /FORGELINE access decision/ })).toBeVisible();
  await page.getByLabel('Command search').press('Enter');
  await expect(page.getByText('Memory inspector')).toBeVisible();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await page.getByLabel('Quick capture text').fill('DNS failover validated during the test workflow.');
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'DNS failover validated during the test workflow.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'DNS failover validated during the test workflow.' }),
  ).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/05-inbox.png' });
});
test('Create project and entity, connect real nodes, inspect graph and timeline', async ({ page }) => {
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Memory title').fill('FORGELINE');
  await page.getByLabel('Memory content').fill('Test project for the full workflow.');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/06-projects.png' });
  await page.getByRole('button', { name: 'Brain', exact: true }).click();
  await page.getByRole('button', { name: 'Create entity', exact: true }).click();
  await page.getByLabel('Entity name').fill('MGMT01');
  await page.getByLabel('Entity type').fill('device');
  await page.getByRole('button', { name: 'Create entity', exact: true }).last().click();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Add relationship', exact: true }).click();
  await page.getByLabel('Relationship type').fill('governed_by');
  await page.getByLabel('Relationship target').selectOption(noteId);
  await page.getByRole('button', { name: 'Save relationship' }).click();
  await expect(page.getByText('Relationship saved')).toBeVisible();
  expect(brain.graph.view().relationships.length).toBe(1);
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.locator('canvas')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/07-graph-overview.png' });
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The story so far.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'governed_by' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/08-timeline.png' });
});
test('Tasks persist, arbitrary files import, and original evidence downloads unchanged', async ({ page }) => {
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByLabel('Task title').fill('Verify actual restore');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByRole('button', { name: 'Complete Verify actual restore' }).click();
  await expect(page.getByLabel('Status of Verify actual restore')).toHaveValue('done');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/09-tasks.png' });
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await page.getByLabel('Import files', { exact: true }).setInputFiles({
    name: 'proof.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Recovery evidence\n\nThis exact original must survive.'),
  });
  await expect(page.getByRole('heading', { name: 'proof.md', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Original', exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(readFileSync(path!, 'utf8')).toBe('# Recovery evidence\n\nThis exact original must survive.');
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/10-sources.png' });
});
test('Evidence-only Ask shows citations while no external network requests occur', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(service.origin)) external.push(request.url());
  });
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByLabel('Ask a question').fill('Why RDP MGMT01?');
  await page.getByRole('button', { name: 'Ask', exact: true }).last().click();
  await expect(page.getByText('S1', { exact: true })).toBeVisible();
  await expect(page.getByText('Local evidence · no model call')).toBeVisible();
  expect(external).toEqual([]);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/11-ask.png' });
  await page.getByRole('button', { name: /S1.*FORGELINE/ }).click();
  await expect(page.getByRole('heading', { name: 'FORGELINE access decision' })).toBeVisible();
});
test('Backup through UI, verify, restore into new directory, and run Doctor', async ({ page }) => {
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.getByText('Why RDP MGMT01?', { exact: true })).toBeVisible();
  await expect(page.getByText('S1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Backups', exact: true }).click();
  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText('Backup complete', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Verification complete', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/12-backups.png' });
  const parent = temporary('e2e-restore');
  try {
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByLabel('Restore destination').fill(join(parent, 'restored'));
    await page.getByRole('button', { name: 'Verify & restore' }).click();
    await expect(page.getByText(/Restored to/)).toBeVisible();
    const restored = new Brain(join(parent, 'restored'));
    try {
      expect(restored.memories.get(noteId).version).toBe(2);
      expect(restored.doctor(true).ok).toBe(true);
    } finally {
      await restored.close();
    }
  } finally {
    removeTemporary(parent);
  }
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('button', { name: 'Run Doctor' }).click();
  await expect(page.getByText('Your brain passed all checks.')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/13-doctor.png' });
  const response = await page.request.post(service.origin + '/api/jobs', {
    headers: { Authorization: `Bearer ${service.token}` },
    data: { type: 'rebuild' },
  });
  expect(response.status()).toBe(202);
  const job = await response.json();
  await expect.poll(() => brain.jobs.list().find((item) => item.id === job.id)?.status).toBe('done');
  expect(brain.doctor(true).ok).toBe(true);
});
test('Application restart preserves memory and invalidates old sessions', async ({ page }) => {
  const oldToken = service.token;
  await service.close();
  brain = new Brain(root);
  service = await serve(brain, { port: 0 });
  const denied = await page.request.get(service.origin + '/api/status', {
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  expect(denied.status()).toBe(401);
  await page.goto(service.url);
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'FORGELINE access decision' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/14-notes.png' });
});
test('Small viewport remains usable and all navigation controls have accessible names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes & memories' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/15-mobile-notes.png' });
  await page.getByRole('button', { name: 'Quick capture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Catch a thought' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: 'artifacts/screenshots/16-mobile-capture.png' });
});
