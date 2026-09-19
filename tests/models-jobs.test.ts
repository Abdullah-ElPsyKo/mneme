import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateEndpoint } from '../server/security/settings.js';
import { withBrain } from './helpers.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpModelProvider } from '../server/models/provider.js';
test('Local-only policy rejects remote hosts, credentials, redirects and insecure cloud endpoints', () => {
  for (const endpoint of [
    'https://example.com/v1',
    'http://127.0.0.1.evil.invalid/v1',
    'file:///C:/private',
    'http://user:secret@localhost:11434',
    'http://192.168.1.1:11434',
  ])
    assert.throws(() => validateEndpoint(endpoint, true));
  assert.throws(() => validateEndpoint('http://example.com', false), /HTTPS/);
  assert.equal(validateEndpoint('http://127.0.0.1:11434', true).hostname, '127.0.0.1');
});
test('OpenAI-compatible generation, streaming and embedding run against a local protocol fixture', () =>
  withBrain(async (brain) => {
    const requests: any[] = [];
    const endpoint = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      requests.push({ path: req.url, body });
      if (req.url === '/v1/embeddings') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ embedding: [1, 0.2, -0.1] }] }));
      } else {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: 'Management is restricted ' } }] }) +
            '\n\n',
        );
        res.write(
          'data: ' + JSON.stringify({ choices: [{ delta: { content: 'to MGMT01 [S1].' } }] }) + '\n\n',
        );
        res.end('data: [DONE]\n\n');
      }
    });
    await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', r));
    const port = (endpoint.address() as any).port;
    try {
      brain.settings.update({
        ...brain.settings.data,
        provider: 'openai-compatible',
        endpoint: `http://127.0.0.1:${port}/v1`,
        model: 'local-fixture',
        embedding_model: 'embed-fixture',
      });
      brain.memories.save({
        title: 'Management access',
        body: 'Administrative access is restricted to MGMT01.',
      });
      const answer = await brain.ask('Management', true);
      assert.equal(answer.mode, 'model');
      assert.match(answer.answer!, /MGMT01 \[S1\]/);
      assert.equal(requests[0].body.messages[0].role, 'system');
      assert.match(requests[0].body.messages[1].content, /untrusted data/);
      assert.deepEqual(await brain.provider.embed('test'), [1, 0.2, -0.1]);
    } finally {
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  }));
test('Ollama NDJSON and embedding protocol work, and provider outages degrade to evidence', () =>
  withBrain(async (brain) => {
    const requests: any[] = [];
    const endpoint = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ path: req.url, body: JSON.parse(body) });
      if (req.url === '/api/embed') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
      } else {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.end(
          JSON.stringify({ message: { content: 'Local answer [S1]' } }) +
            '\n' +
            JSON.stringify({ done: true }) +
            '\n',
        );
      }
    });
    await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', r));
    const port = (endpoint.address() as any).port;
    brain.settings.update({
      ...brain.settings.data,
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${port}`,
      model: 'qwen3.5:9b',
      embedding_model: 'qwen3-embedding:0.6b',
    });
    try {
      assert.equal(await brain.provider.generate({ system: 'system', prompt: 'data' }), 'Local answer [S1]');
      assert.deepEqual(await brain.provider.embed('test'), [0.1, 0.2, 0.3]);
      assert.equal(requests[0].body.think, false);
      assert.equal(requests[0].path, '/api/chat');
      assert.equal(requests[0].body.model, 'qwen3.5:9b');
      assert.equal(requests[1].path, '/api/embed');
      assert.equal(requests[1].body.model, 'qwen3-embedding:0.6b');
    } finally {
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
    brain.memories.save({ title: 'Offline safety', body: 'Still works.' });
    const result = await brain.ask('safety', true);
    assert.equal(result.mode, 'evidence');
    assert.match(result.warning!, /Local model unavailable/);
    assert.equal(result.context.evidence.length, 1);
  }));
test('Model deadlines allow ongoing generation and distinguish startup, stall and cancellation', () =>
  withBrain(async (brain) => {
    let mode = 'progress';
    const endpoint = createServer(async (req, res) => {
      req.resume();
      if (mode === 'startup') return;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { content: 'a' } }) + '\n');
      if (mode !== 'progress') return;
      let count = 0;
      const timer = setInterval(() => {
        res.write(JSON.stringify({ message: { content: 'b' } }) + '\n');
        if (++count === 12) {
          clearInterval(timer);
          res.end();
        }
      }, 30);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', r));
    brain.settings.update({
      ...brain.settings.data,
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${(endpoint.address() as any).port}`,
      model: 'fixture',
    });
    const provider = new HttpModelProvider(brain.settings, { startupMs: 180, idleMs: 120 });
    try {
      assert.equal(await provider.generate({ system: 's', prompt: 'p' }), 'a' + 'b'.repeat(12));
      mode = 'startup';
      await assert.rejects(provider.generate({ system: 's', prompt: 'p' }), /startup window/);
      mode = 'stall';
      await assert.rejects(provider.generate({ system: 's', prompt: 'p' }), /stalled/);
      const controller = new AbortController();
      const stream = provider.stream({ system: 's', prompt: 'p', signal: controller.signal });
      assert.equal((await stream[Symbol.asyncIterator]().next()).value, 'a');
      controller.abort();
      await assert.rejects(
        async () => {
          for await (const _ of stream) {
          }
        },
        { name: 'AbortError' },
      );
    } finally {
      endpoint.closeAllConnections();
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  }));

test('Provider HTTP redirects cannot bypass the privacy boundary', () =>
  withBrain(async (brain) => {
    const endpoint = createServer((_req, res) => {
      res.writeHead(302, { Location: 'https://example.com' });
      res.end();
    });
    await new Promise<void>((r) => endpoint.listen(0, '127.0.0.1', r));
    brain.settings.update({
      ...brain.settings.data,
      provider: 'ollama',
      endpoint: `http://127.0.0.1:${(endpoint.address() as any).port}`,
      model: 'fixture',
    });
    try {
      await assert.rejects(() => brain.provider.generate({ system: 's', prompt: 'p' }), /unavailable/);
    } finally {
      await new Promise<void>((r) => endpoint.close(() => r()));
    }
  }));
test('Durable queue runs a real rebuild worker, deduplicates, pauses and resumes', () =>
  withBrain(async (brain) => {
    brain.memories.save({ title: 'Background indexing', body: 'Rebuild this memory.' });
    brain.storage.index.exec('DELETE FROM documents; DELETE FROM indexed');
    brain.settings.update({ ...brain.settings.data, background: false });
    brain.jobs.start();
    const job = brain.jobs.enqueue('rebuild', {}, 'rebuild');
    assert.equal(brain.jobs.enqueue('rebuild', {}, 'rebuild').id, job.id);
    assert.equal(brain.jobs.list()[0].status, 'queued');
    brain.settings.update({ ...brain.settings.data, background: true });
    brain.jobs.wake();
    const deadline = Date.now() + 15000;
    while (brain.jobs.list().find((j) => j.id === job.id)?.status !== 'done' && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      brain.jobs.list().find((j) => j.id === job.id)?.status,
      'done',
      JSON.stringify(brain.jobs.list()),
    );
    assert.equal(brain.search.query('Rebuild this memory').length, 1);
  }));
test(
  'Windows credentials use current-user DPAPI and never persist as plaintext',
  { skip: process.platform !== 'win32' || !!process.env.MNEME_API_KEY },
  () =>
    withBrain((brain) => {
      const secret = 'test-credential-DO-NOT-USE-IN-PRODUCTION';
      brain.settings.secret(secret);
      const protectedBytes = readFileSync(join(brain.storage.root, 'config/provider-key.dpapi'), 'utf8');
      assert.ok(!protectedBytes.includes(secret));
      assert.equal(brain.settings.secret(), secret);
    }),
);
