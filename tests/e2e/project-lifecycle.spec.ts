import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';

test('Create, edit and filter project lifecycle while retaining associated notes and project history', async ({
  page,
}) => {
  const root = temporary('projects-ui');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  const note = brain.memories.save({
    title: 'Keep associated note',
    project: 'Future workshop',
    status: 'inbox',
  });
  for (const state of ['planned', 'active', 'paused', 'completed', 'abandoned'] as const)
    brain.memories.save({
      title: `${state} project fixture`,
      type: 'project',
      project_state: state,
      tags: ['fixture'],
    });
  const service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(page.locator('.project-item')).toHaveCount(5);
    for (const state of ['planned', 'active', 'paused', 'completed', 'abandoned']) {
      await page.getByLabel('Filter project lifecycle').selectOption(state);
      await expect(page.locator('.project-item')).toHaveCount(1);
      await expect(page.locator('.project-item .state-label')).toHaveText(state);
    }
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await expect(page.getByLabel('Filter project lifecycle')).toHaveValue('');
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await expect(page.getByLabel('Project lifecycle', { exact: true })).toHaveValue('planned');
    await page.getByLabel('Memory title').fill('Future workshop');
    await page.getByLabel('Memory content').fill('Keep planning and project history.');
    await page.getByLabel('Project lifecycle', { exact: true }).selectOption('paused');
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const project = brain.memories.list({ type: 'project' }).find((m) => m.title === 'Future workshop')!;
    expect(project.project_state).toBe('paused');
    for (const state of ['planned', 'active', 'completed', 'abandoned']) {
      await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
      await page.getByLabel('Project lifecycle', { exact: true }).selectOption(state);
      await page.getByRole('button', { name: 'Save memory', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.inspector .entity-metadata')).toContainText(state);
      expect(brain.memories.get(project.id).project_state).toBe(state);
      expect(brain.memories.get(note.id)).toEqual(note);
    }
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.getByLabel('Filter project lifecycle').selectOption('active');
    await expect(page.locator('.project-item')).toHaveCount(1);
    await expect(page.locator('.project-item')).not.toContainText('Future workshop');
    await page.getByLabel('Filter project lifecycle').selectOption('abandoned');
    await expect(page.locator('.project-item')).toHaveCount(2);
    await page.getByLabel('Filter projects').fill('Future workshop');
    await expect(page.locator('.project-item')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/project-lifecycle.png', fullPage: true });
    await page.locator('.project-item').click();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.history-item')).toHaveCount(5);
    expect(brain.memories.events.list({ aggregate: project.id })).toHaveLength(5);
    await page.reload();
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await page.getByLabel('Filter project lifecycle').selectOption('abandoned');
    await expect(page.locator('.project-item')).toHaveCount(2);
    expect(brain.memories.get(note.id).project).toBe('Future workshop');
    expect(brain.memories.get(note.id).status).toBe('inbox');
    expect(brain.doctor(true).ok).toBe(true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});
