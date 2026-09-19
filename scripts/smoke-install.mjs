import { Brain } from '../dist/server/app.js';
import { serve } from '../dist/server/api/server.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const brain = new Brain(resolve('.smoke-brain'));
brain.memories.save({ title: 'Clean installation', body: 'Independent dependency installation succeeded.' });
const service = await serve(brain, { port: 0 });
try {
  const page = await fetch(service.origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mneme/);
  const search = await fetch(service.origin + '/api/search?q=Independent', {
    headers: { Authorization: `Bearer ${service.token}` },
  });
  assert.equal((await search.json()).hits.length, 1);
  const job = brain.jobs.enqueue('rebuild');
  for (let i = 0; i < 100 && brain.jobs.list().find((item) => item.id === job.id)?.status !== 'done'; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(brain.jobs.list().find((item) => item.id === job.id)?.status, 'done');
  assert.equal(brain.doctor(true).ok, true);
  console.log(
    'Clean installation: production assets, API, canonical storage, search, worker and Doctor passed.',
  );
} finally {
  await service.close();
}
