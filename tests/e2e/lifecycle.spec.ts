import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';

test('Facts repeater and supersession picker persist, edit and erase through reviewed UI', async ({
  page,
}) => {
  const root = temporary('lifecycle-ui');
  let brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  const a = brain.memories.save({
    title: 'Joint 2 uses NEMA17',
    body: 'OldJointMotorNeedle',
    project: 'ARM-01',
  });
  const before = new Date().toISOString();
  let service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'New memory', exact: true }).click();
    await page.getByLabel('Memory title').fill('Joint 2 testing completed');
    await page.getByLabel('Memory content').fill('NewJointMotorNeedle');
    await page.getByText('Temporal facts & priority', { exact: true }).click();
    const keys = [
      'joint2.current_torque',
      'joint2.max_torque',
      'joint2.temperature',
      'joint2.controller_gain',
    ];
    const values = ['1.0 Nm', '8.4 Nm', '54.2 °C', '0.65'];
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: '+ Add fact', exact: true }).click();
      await page.getByLabel(`Fact key ${i + 1}`, { exact: true }).fill(keys[i]);
      await page.getByLabel(`Fact value ${i + 1}`, { exact: true }).fill(values[i]);
    }
    await page.getByLabel('Search superseded memory').fill('NEMA17');
    await page.getByRole('button', { name: /Joint 2 uses NEMA17.*ARM-01/ }).click();
    await expect(page.getByRole('dialog').getByText(a.title, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Joint 2 testing completed', exact: true })).toBeVisible();
    const b = brain.memories.list().find((m) => m.title === 'Joint 2 testing completed')!;
    expect(b.supersedes).toBe(a.id);
    expect(b.facts).toHaveLength(4);
    expect((await brain.context('OldJointMotorNeedle')).context.evidence).toHaveLength(0);
    expect(brain.search.query('OldJointMotorNeedle', { at: before })[0].memory.id).toBe(a.id);
    const firstRevisionTime = new Date().toISOString();
    await page.goto('about:blank');
    await service.close();
    brain = new Brain(root);
    service = await serve(brain, { port: 0 });
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    await page.getByRole('heading', { name: b.title, exact: true }).click();
    await page.getByRole('button', { name: 'Edit memory', exact: true }).click();
    await page.getByText('Temporal facts & priority', { exact: true }).click();
    await expect(page.getByRole('dialog').getByText(a.title, { exact: true })).toBeVisible();
    for (let i = 0; i < 4; i++)
      await expect(page.getByLabel(`Fact value ${i + 1}`, { exact: true })).toHaveValue(values[i]);
    await page.getByLabel('Search superseded memory').fill('testing completed');
    await expect(page.getByRole('button', { name: /Joint 2 testing completed.*No project/ })).toHaveCount(0);
    await page.getByLabel('Fact value 1', { exact: true }).fill('1.2 Nm');
    await page.getByRole('button', { name: 'Remove fact 2', exact: true }).click();
    await page.getByRole('button', { name: '+ Add fact', exact: true }).click();
    await page.getByLabel('Fact key 4', { exact: true }).fill('joint2.speed');
    await page.getByLabel('Fact value 4', { exact: true }).fill('2 rpm');
    await page.screenshot({ path: 'test-results/lifecycle-editor.png', fullPage: true });
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(brain.memories.get(b.id).facts.map((f) => f.value)).toEqual([
      '1.2 Nm',
      '54.2 °C',
      '0.65',
      '2 rpm',
    ]);
    expect(brain.memories.get(b.id, firstRevisionTime).facts.map((f) => f.value)).toEqual(values);
    await page.getByRole('button', { name: `Delete permanently: ${b.title}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete permanently', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(brain.memories.get(b.id).version).toBe(2);
    await page.getByRole('button', { name: `Delete permanently: ${b.title}`, exact: true }).click();
    await page.getByRole('checkbox', { name: /I understand/ }).check();
    await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(() => brain.memories.get(b.id)).toThrow();
    expect(brain.memories.events.list({ aggregate: b.id })).toHaveLength(0);
    expect(brain.doctor(true).ok).toBe(true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});
