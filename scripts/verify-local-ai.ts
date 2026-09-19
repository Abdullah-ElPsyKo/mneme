// Opt-in acceptance check against the user's running local Ollama. Synthetic
// evidence only; no personal brain is opened or sent to a model.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { temporary, removeTemporary } from '../tests/helpers.js';

const root = temporary('ollama-acceptance');
const brain = new Brain(root);
brain.settings.update({
  ...brain.settings.data,
  provider: 'ollama',
  local_only: true,
  endpoint: 'http://127.0.0.1:11434',
  model: 'qwen3.5:9b',
  embedding_model: 'qwen3-embedding:0.6b',
  background: false,
  context_budget: 8192,
});
brain.memories.save({
  title: 'Administrative RDP boundary',
  body: 'Restrict administrative RDP to MGMT01. The FL - Allow RDP TCP from MGMT policy reduces management entry points. This makes access easier to audit and limits unintended lateral movement. Synthetic desktop acceptance evidence.',
});
const server = await serve(brain, { port: 0, desktop: true });
const originalFetch = globalThis.fetch;
const inspections: Promise<void>[] = [];
const wire: any[] = [];
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  if (String(input) === 'http://127.0.0.1:11434/api/chat') {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.think, false);
    assert.equal(body.model, 'qwen3.5:9b');
    const record = { model: body.model, think: body.think, thinking_chunks: 0, done: false, eval_count: 0 };
    wire.push(record);
    inspections.push(
      response
        .clone()
        .text()
        .then((text) => {
          for (const line of text.trim().split('\n')) {
            const chunk = JSON.parse(line);
            if (chunk.message?.thinking) record.thinking_chunks++;
            if (chunk.done) {
              record.done = true;
              record.eval_count = chunk.eval_count;
            }
          }
        }),
    );
  }
  return response;
};
const runs: any[] = [];
try {
  for (const label of ['first', 'warm']) {
    const started = performance.now();
    const response = await fetch(server.origin + '/api/ask/stream', {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Why is administrative RDP restricted to MGMT01?', use_model: true }),
    });
    assert.equal(response.status, 200);
    let buffer = '',
      answer = '',
      firstTokenMs: number | undefined,
      done = false;
    const warnings: string[] = [];
    for await (const bytes of response.body!) {
      buffer += Buffer.from(bytes).toString('utf8');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = block.match(/^event: (.+)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}');
        if (event === 'token' && data.text) {
          firstTokenMs ??= performance.now() - started;
          answer += data.text;
        }
        if (event === 'warning') warnings.push(data.message);
        if (event === 'done') done = true;
      }
    }
    const result = {
      label,
      first_token_ms: Math.round(firstTokenMs ?? -1),
      total_ms: Math.round(performance.now() - started),
      answer_characters: answer.length,
      cited: /\[S1\]/.test(answer),
      warnings,
      done,
    };
    runs.push(result);
    console.log(JSON.stringify(result));
    assert.ok(done && answer.length > 0, JSON.stringify(result));
    assert.ok(!warnings.some((w) => /timeout|stalled|startup window/i.test(w)), JSON.stringify(result));
  }
  const started = performance.now();
  const vector = await brain.provider.embed('MGMT01 is the administrative access boundary.');
  await Promise.all(inspections);
  assert.ok(wire.every((r) => r.done && r.thinking_chunks === 0));
  const report = {
    measured_at: new Date().toISOString(),
    endpoint: brain.settings.data.endpoint,
    runs,
    wire,
    embedding: {
      model: brain.settings.data.embedding_model,
      dimensions: vector.length,
      elapsed_ms: Math.round(performance.now() - started),
    },
  };
  mkdirSync('artifacts/desktop', { recursive: true });
  writeFileSync('artifacts/desktop/local-ai.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
  removeTemporary(root);
}
