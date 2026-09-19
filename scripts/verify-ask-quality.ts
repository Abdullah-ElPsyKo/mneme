// Explicit local-model verification with disposable fixtures only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { Brain } from '../server/app.js';
import { temporary, removeTemporary } from '../tests/helpers.js';
import { askFixture } from '../tests/ask-fixture.js';
import { embeddingText } from '../server/retrieval/evidence.js';
import { compileContext } from '../server/context/compiler.js';
import { askSystem } from '../server/context/style.js';
import { tokens } from '../server/core/util.js';
const root = temporary('ask-ollama-quality');
const brain = new Brain(root);
const results: any[] = [];
const styleOnly = process.argv.includes('--style');
const conflictOnly = process.argv.includes('--conflict');
const diagnosticsOnly = process.argv.includes('--diagnostics');
try {
  const fixture = askFixture(brain);
  brain.settings.update({
    ...brain.settings.data,
    background: false,
    local_only: true,
    provider: 'ollama',
    endpoint: 'http://127.0.0.1:11434',
    model: 'qwen3.5:9b',
    embedding_model: 'qwen3-embedding:0.6b',
  });
  const queries = [
    'What is FORGELINE and what is its purpose?',
    'What projects am I actively working on and which are completed?',
    'What is my hardware configuration?',
    'Is AWS Architecture active or completed?',
    'What is my test GPU maximum price?',
    'What is my lunar telescope password?',
  ];
  for (const query of conflictOnly || diagnosticsOnly ? [] : styleOnly ? queries.slice(2, 5) : queries) {
    const started = performance.now();
    const result = await brain.ask(query, true);
    const row = {
      query,
      ...result.diagnostics,
      latency_ms: Math.round(performance.now() - started),
      answer: result.answer,
      warning: result.warning || null,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  if (!diagnosticsOnly) {
    brain.memories.save({
      title: 'Robot arm motor selection',
      body: 'The selected motor for your robotic arm is NEMA17.',
      facts: [{ key: 'robot.motor', value: 'NEMA17' }],
    });
    brain.memories.save({
      title: 'Robot arm motor decision',
      body: 'The selected motor for your robotic arm is NEMA23.',
      facts: [{ key: 'robot.motor', value: 'NEMA23' }],
    });
    const started = performance.now();
    const conflict = await brain.ask('What motor did I select for the robotic arm?', true);
    const row = {
      query: conflict.context.query,
      ...conflict.diagnostics,
      latency_ms: Math.round(performance.now() - started),
      answer: conflict.answer,
      warning: conflict.warning || null,
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  if (diagnosticsOnly)
    for (const query of queries) {
      const result = await brain.context(query);
      const unfiltered = compileContext(query, result.hits, 32000);
      const row = {
        query,
        ...result.diagnostics,
        unfiltered_context_tokens: unfiltered.estimated_tokens,
        total_prompt_tokens: tokens(askSystem + '\n' + result.context.prompt),
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  if (!styleOnly && !conflictOnly && !diagnosticsOnly) {
    for (const preview of brain.memories.list()) {
      const memory = brain.memories.get(preview.id);
      brain.search.storeVector(
        memory,
        await brain.provider.embed(embeddingText(memory)),
        brain.provider.fingerprint(),
      );
    }
    const semantic = await brain.context('What is my test GPU maximum price?', true);
    results.push({
      query: semantic.context.query,
      semantic: true,
      ...semantic.diagnostics,
      selected_titles: semantic.context.evidence.map((e) => e.title),
      expected_memory: fixture.price.id,
    });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    diagnosticsOnly
      ? 'artifacts/ask-quality-diagnostics.json'
      : conflictOnly
        ? 'artifacts/ask-quality-conflict.json'
        : styleOnly
          ? 'artifacts/ask-quality-style.json'
          : 'artifacts/ask-quality-ollama.json',
    JSON.stringify(results, null, 2) + '\n',
  );
  await brain.close();
  removeTemporary(root);
}
