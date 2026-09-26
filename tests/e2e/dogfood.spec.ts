import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';

for (const count of [8, 350])
  test(`Graph with ${count} nodes, custom types, persistent names and text presets`, async ({ page }) => {
    const root = temporary('graph-dogfood'),
      brain = new Brain(root);
    brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
    const nodes = Array.from({ length: count }, (_, i) =>
      brain.graph.entity({ name: `Fixture ${i}`, type: ['device', 'person', 'custom_type'][i % 3] }),
    );
    for (let i = 1; i < count; i++)
      brain.graph.link({
        from_id: nodes[i - 1].id,
        to_id: nodes[i].id,
        type: ['uses', 'depends_on', 'custom_link'][i % 3],
      });
    const service = await serve(brain, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(service.url);
      await expect(page.locator('canvas')).toHaveAttribute('aria-label', new RegExp(`${count} entities`));
      await page.getByText('Graph key', { exact: true }).click();
      await expect(page.locator('.graph-legend')).toContainText('custom link');
      const labels = page.getByRole('button', { name: 'Show memory and entity names' });
      await labels.click();
      await expect(labels).toHaveAttribute('aria-pressed', 'false');
      await page.reload();
      await expect(labels).toHaveAttribute('aria-pressed', 'false');
      await labels.click();
      await expect(labels).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.screenshot({ path: `test-results/graph-${count}.png` });
      await page.getByRole('button', { name: 'Entity list', exact: true }).click();
      await expect(page.locator('.graph-accessible-list button')).toHaveCount(count);
      await page.locator('.graph-accessible-list button').first().click();
      await expect(page.locator('.inspector')).toBeVisible();
      await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
      await page.getByRole('button', { name: 'Create entity', exact: true }).click();
      await page.getByLabel('Entity name', { exact: true }).fill('Custom entity');
      await page.getByLabel('Entity type', { exact: true }).fill('legacy_custom_type');
      await expect(page.locator('#entity-type-suggestions option')).toHaveCount(8);
      await page.getByRole('button', { name: 'Create entity', exact: true }).last().click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.inspector')).toContainText('legacy custom type');
      await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
      brain.structured.task({
        title: 'Inspect the synthetic network fixture',
        project: 'Synthetic roadmap',
        due_at: '2027-01-01',
      });
      brain.memories.save({ title: 'Synthetic roadmap', type: 'project', project_state: 'planned' });
      brain.memories.save({
        title: 'Readable fixture note',
        body: 'A longer body for checking text size and line wrapping.',
      });
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await page.getByLabel('Ask a question').fill('What tasks do I have?');
      await page.getByLabel('Ask a question').press('Enter');
      await page.getByText('Sources · 1', { exact: true }).click();
      await page.locator('.task-source summary').click();
      await expect(page.locator('.task-source')).toContainText('2027-01-01');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      for (const preset of ['compact', 'default', 'large']) {
        await page.getByLabel('Text size', { exact: true }).selectOption(preset);
        await page.getByRole('button', { name: 'Save preferences' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-text-size', preset);
      }
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
      for (const width of [1440, 800, 390]) {
        await page.setViewportSize({ width, height: 960 });
        for (const view of ['Tasks', 'Projects', 'Notes', 'Ask', 'Settings']) {
          await page.getByRole('button', { name: view, exact: true }).click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        await page.screenshot({ path: `test-results/large-text-${count}-${width}.png` });
      }
      expect(errors).toEqual([]);
    } finally {
      await service.close();
      removeTemporary(root);
    }
  });
