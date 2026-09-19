import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
import { temporary, removeTemporary } from '../tests/helpers.js';
const root = temporary('import-profile');
const brain = new Brain(root);
brain.settings.update({ ...brain.settings.data, background: false });
const server = await serve(brain, { port: 0 });
const results: any[] = [];
try {
  for (const sizeMiB of [5, 50]) {
    const bytes = Buffer.alloc(sizeMiB * 1024 * 1024, sizeMiB);
    const payload = JSON.stringify({
      name: `synthetic-${sizeMiB}MiB.bin`,
      content: bytes.toString('base64'),
    });
    const begin = performance.now();
    const response = await fetch(server.origin + '/api/import', {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!response.ok) throw new Error(`Import failed: ${response.status}`);
    const data = await response.json();
    results.push({
      size_mib: sizeMiB,
      api_ms: performance.now() - begin,
      preserved_bytes: data.source.size,
      rss_mib: process.memoryUsage().rss / 1024 / 1024,
    });
  }
  if (!brain.doctor(true).ok) throw new Error('Integrity verification failed');
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/import-performance.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await server.close();
  removeTemporary(root);
}
