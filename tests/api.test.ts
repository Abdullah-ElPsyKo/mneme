import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { serve } from '../server/api/server.js';
import { Brain } from '../server/app.js';
import { temporary, removeTemporary } from './helpers.js';

test('Shutdown persists an interrupted streaming answer before closing SQLite', async () => {
  const root = temporary('shutdown');
  let brain = new Brain(root);
  brain.memories.save({ title: 'Shutdown evidence', body: 'A known fact.' });
  brain.provider.stream = async function* (request) {
    yield 'Partial answer [S1].';
    if (!request.signal?.aborted)
      await new Promise<void>((resolve) =>
        request.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    throw new Error('Generation interrupted');
  };
  const server = await serve(brain, { port: 0 });
  try {
    const response = await fetch(server.origin + '/api/ask/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Shutdown', use_model: true }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await server.close();
    await reader.cancel().catch(() => {});
    brain = new Brain(root);
    const turn = brain.conversations.list()[0];
    assert.equal(turn.status, 'interrupted');
    assert.equal(turn.answer, 'Partial answer [S1].');
    assert.equal(brain.doctor(true).ok, true);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
});
test('Loopback API requires authentication, blocks cross-origin/rebinding, validates mutations and persists data', async () => {
  const root = temporary('api');
  const brain = new Brain(root);
  brain.settings.update({ ...brain.settings.data, background: false });
  const server = await serve(brain, { port: 0 });
  const call = (path: string, method = 'GET', data?: unknown, extra: Record<string, string> = {}) =>
    fetch(server.origin + path, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json', ...extra },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
  try {
    assert.equal((await fetch(server.origin + '/api/status')).status, 401);
    assert.equal(
      (await call('/api/status', 'GET', undefined, { Origin: 'https://evil.invalid' })).status,
      403,
    );
    const rebound = await new Promise<number>((resolve) => {
      const req = httpRequest(
        server.origin + '/api/status',
        { headers: { Host: 'evil.invalid', Authorization: `Bearer ${server.token}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.end();
    });
    assert.equal(rebound, 403);
    assert.equal((await call('/api/memories', 'POST', { title: 'bad', unexpected: 'reject' })).status, 400);
    assert.equal((await call('/api/memories', 'POST', { title: 'bad', private: 'yes' })).status, 400);
    const saved = await (
      await call('/api/memories', 'POST', { title: 'API persistence', body: '# Authentic evidence' })
    ).json();
    assert.ok(saved.id);
    assert.equal(
      (await call(`/api/memories/${saved.id}`, 'PUT', { title: 'Stale', expected_version: 999 })).status,
      409,
    );
    const session = await call('/api/session', 'POST', { token: server.token });
    const cookie = session.headers.get('set-cookie')!.split(';')[0];
    assert.match(session.headers.get('set-cookie')!, /HttpOnly/);
    assert.equal((await fetch(server.origin + '/api/status', { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await (await call('/api/search?q=Authentic')).json()).hits[0].memory.id, saved.id);
    const imported = await (
      await call('/api/import', 'POST', {
        name: '../../untouched.txt',
        content: Buffer.from('Safe import').toString('base64'),
      })
    ).json();
    assert.ok(imported.memory.id);
    const download = await call(`/api/sources/${imported.source.id}/download`);
    assert.equal(await download.text(), 'Safe import');
    assert.match(download.headers.get('content-disposition')!, /^attachment/);
    assert.match(download.headers.get('content-security-policy')!, /object-src 'none'/);
    assert.equal((await call('/api/ask', 'POST', { query: 'Authentic' })).status, 200);
    const context = await (await call('/api/context', 'POST', { query: 'Authentic' })).json();
    assert.equal(context.context.evidence.length, 1);
    const stream = await call('/api/ask/stream', 'POST', { query: 'Authentic' });
    assert.match(await stream.text(), /event: context/);
    assert.equal(
      (await call('/api/jobs', 'POST', { type: 'execute-shell', payload: { command: 'bad' } })).status,
      400,
    );
    assert.equal(
      (
        await call('/api/settings', 'PUT', {
          ...brain.settings.data,
          provider: 'openai-compatible',
          endpoint: 'https://example.com/v1',
          model: 'test',
        })
      ).status,
      403,
    );
    assert.equal((await call('/api/sources/not-a-source/download')).status, 404);
  } finally {
    await server.close();
  }
  const reopened = new Brain(root);
  try {
    assert.equal(reopened.search.query('API persistence').length, 1);
  } finally {
    await reopened.close();
    removeTemporary(root);
  }
});
