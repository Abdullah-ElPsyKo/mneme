import { test, expect } from '@playwright/test';
import { Brain } from '../../dist/server/app.js';
import { serve } from '../../dist/server/api/server.js';
import { temporary, removeTemporary } from '../helpers.js';
import { askFixture } from '../ask-fixture.js';

test('Long Ask conversation stays chronological; streaming follows until you scroll up; sources are collapsed and accurate', async ({
  page,
}) => {
  const root = temporary('ask-scroll-ui');
  const brain = new Brain(root);
  brain.settings.update({
    ...brain.settings.data,
    onboarded: true,
    background: false,
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: 'fixture',
  });
  const f = askFixture(brain);
  const context = (await brain.context('hardware configuration')).context;
  for (let i = 0; i < 36; i++) {
    const turn = brain.conversations.begin(`Earlier question ${i}`, context, null);
    brain.conversations.finish(
      turn.id,
      `Earlier answer ${i}. ` + 'A longer paragraph about your recorded hardware. '.repeat(20) + '[S1]',
    );
  }
  // Timestamp ties must not reorder turns according to random UUIDs.
  brain.storage.db.exec("UPDATE ask_turns SET created_at='2026-01-01T00:00:00.000Z'");
  brain.provider.stream = async function* () {
    for (let i = 0; i < 90; i++) {
      yield `Stream ${i}: Your hardware is recorded here.\n\n`;
      await new Promise((r) => setTimeout(r, 70));
    }
    yield '[S1]';
  };
  const service = await serve(brain, { port: 0 });
  const distance = () =>
    page
      .getByRole('log', { name: 'Ask conversation' })
      .evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const turns = page.locator('.ask-turn');
    await expect(turns).toHaveCount(36);
    await expect(turns.first().getByRole('heading')).toHaveText('Earlier question 0');
    await expect(turns.last().getByRole('heading')).toHaveText('Earlier question 35');
    await expect.poll(distance).toBeLessThan(5);
    await expect(turns.last().getByText('Sources · 1', { exact: true })).toBeVisible();
    await expect(turns.last().getByRole('button', { name: /Your hardware configuration/ })).toBeHidden();
    const scroll = await page.getByRole('log').evaluate((e) => e.scrollTop);
    await turns.last().getByText('Sources · 1', { exact: true }).click();
    expect(Math.abs((await page.getByRole('log').evaluate((e) => e.scrollTop)) - scroll)).toBeLessThan(5);
    await turns.last().getByText('Sources · 1', { exact: true }).click();
    await page.getByRole('checkbox', { name: 'Use fixture', exact: true }).check();
    await page.getByLabel('Ask a question').fill('What is my hardware configuration?');
    await page.getByLabel('Ask a question').press('Enter');
    await expect(turns).toHaveCount(37);
    await expect(turns.last().getByRole('heading')).toHaveText('What is my hardware configuration?');
    await expect(turns.last().locator('.markdown')).toContainText('Stream 10:');
    await expect.poll(distance).toBeLessThan(64);
    await page.getByRole('log').hover();
    await page.mouse.wheel(0, -1000);
    await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    const held = await page.getByRole('log').evaluate((e) => e.scrollTop);
    await expect(turns.last().locator('.markdown')).toContainText('Stream 45:');
    expect(Math.abs((await page.getByRole('log').evaluate((e) => e.scrollTop)) - held)).toBeLessThan(5);
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await expect.poll(distance).toBeLessThan(64);
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    await expect(turns.last().getByRole('heading')).toHaveText('What is my hardware configuration?');
    await expect.poll(distance).toBeLessThan(64);
    await turns.last().getByText('Sources · 1', { exact: true }).click();
    await expect(turns.last().getByRole('button', { name: /Your hardware configuration/ })).toBeVisible();
    await page.screenshot({ path: 'test-results/ask-quality-sources.png' });
    await turns
      .last()
      .getByRole('button', { name: /Your hardware configuration/ })
      .click();
    await expect(page.getByRole('heading', { name: f.hardware.title, exact: true })).toBeVisible();
  } finally {
    await service.close();
    removeTemporary(root);
  }
});

test('New chat keeps durable history and memories, reloads empty, and isolates new turns', async ({
  page,
}) => {
  const root = temporary('ask-new-chat-ui');
  let brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, onboarded: true, background: false });
  askFixture(brain);
  await brain.ask('What is FORGELINE?');
  const memories = JSON.stringify(brain.storage.db.prepare('SELECT * FROM memories ORDER BY id').all());
  const events = brain.status().events;
  const indexes = JSON.stringify(brain.storage.index.prepare('SELECT * FROM indexed ORDER BY id').all());
  let service = await serve(brain, { port: 0 });
  try {
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What is FORGELINE?', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page.locator('.ask-turn')).toHaveCount(0);
    const freshId = brain.conversations.current();
    expect(brain.conversations.list()).toHaveLength(1);
    expect(JSON.stringify(brain.storage.db.prepare('SELECT * FROM memories ORDER BY id').all())).toBe(
      memories,
    );
    expect(JSON.stringify(brain.storage.index.prepare('SELECT * FROM indexed ORDER BY id').all())).toBe(
      indexes,
    );
    expect(brain.status().events).toBe(events);
    await page.goto('about:blank');
    await service.close();
    brain = new Brain(root);
    service = await serve(brain, { port: 0 });
    await page.goto(service.url);
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.locator('.ask-turn')).toHaveCount(0);
    expect(brain.conversations.current()).toBe(freshId);
    await page.getByLabel('Ask a question').fill('What is my test GPU maximum price?');
    await page.getByLabel('Ask a question').press('Enter');
    await expect(page.locator('.ask-turn')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stop generation' })).toHaveCount(0);
    expect(brain.conversations.list(100, 0, freshId)).toHaveLength(1);
    await page.getByLabel('Ask chat history').selectOption('legacy');
    await expect(page.getByRole('heading', { name: 'What is FORGELINE?', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'What is my test GPU maximum price?', exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('Ask chat history').selectOption(freshId);
    await expect(
      page.getByRole('heading', { name: 'What is my test GPU maximum price?', exact: true }),
    ).toBeVisible();
    expect(brain.doctor(true).ok).toBe(true);
  } finally {
    await service.close();
    removeTemporary(root);
  }
});
