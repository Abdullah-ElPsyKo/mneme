import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Brain } from '../server/app.js';
import { temporary, removeTemporary } from '../tests/helpers.js';
const root = temporary('actual-model');
const brain = new Brain(root);
const model = process.env.MNEME_TEST_MODEL || 'qwen2.5:0.5b';
const results: any[] = [];
try {
  brain.memories.save({
    title: 'RDP management decision',
    body: 'Administrative RDP is allowed only from MGMT01. We restricted management access to reduce the attack surface.',
    type: 'decision',
    project: 'FORGELINE',
  });
  for (const provider of ['ollama', 'openai-compatible'] as const) {
    brain.settings.update({
      ...brain.settings.data,
      provider,
      endpoint: provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:11434/v1',
      model,
      local_only: true,
    });
    const begin = performance.now();
    const response = await brain.ask(
      'Which machine is allowed administrative RDP? Reply with one sentence and cite the evidence.',
      true,
    );
    assert.equal(response.mode, 'model', response.warning);
    assert.ok(response.answer?.trim(), 'The real model returned no answer');
    assert.equal(response.context.evidence.length, 1);
    results.push({
      provider,
      model,
      elapsed_ms: performance.now() - begin,
      answer: response.answer,
      correct_machine_returned: /MGMT01/i.test(response.answer!),
      citations_returned: /\[S1\]/.test(response.answer!),
      warning: response.warning,
      selected_evidence: response.context.evidence.length,
    });
  }
  assert.equal(brain.conversations.list().length, 2);
  assert.equal(brain.status().memories, 1);
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/local-model-verification.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await brain.close();
  removeTemporary(root);
}
