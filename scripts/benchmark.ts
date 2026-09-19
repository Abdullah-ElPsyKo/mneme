import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { Brain } from '../server/app.js';
import { temporary, removeTemporary } from '../tests/helpers.js';
const count = Number(process.argv[2] || 1000);
if (![1000, 10000, 100000].includes(count)) throw new Error('Use 1000, 10000, or 100000');
const root = temporary(`benchmark-${count}`);
let brain = new Brain(root);
const start = performance.now();
const samples: number[] = [];
const results: any = { memories: count, node: process.version, platform: process.platform };
try {
  for (let i = 0; i < count; i++) {
    brain.memories.save({
      title: `Architecture decision ${i}`,
      body:
        `# Decision ${i}\n\nProject FORGELINE-${i % 30} uses Active Directory, DNS, and restricted administrative RDP.\n\nExact identifier: FL-ALLOW-RDP-${i}\n\nRationale: a repeatable boundary reduces configuration drift.\n\n` +
        'Additional implementation evidence and recovery notes. '.repeat(12),
      type: i % 5 ? 'note' : 'decision',
      project: `FORGELINE-${i % 30}`,
      tags: ['infrastructure', i % 2 ? 'windows' : 'network'],
      importance: 0.5,
    });
    if (i && i % 1000 === 0) console.log(`Imported ${i} / ${count}`);
  }
  results.ingestion_ms = performance.now() - start;
  for (const q of ['"FL-ALLOW-RDP-712"', 'project:FORGELINE-12 type:decision RDP', 'Active Directory DNS']) {
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const begin = performance.now();
      brain.search.query(q);
      times.push(performance.now() - begin);
    }
    times.sort((a, b) => a - b);
    (results.search ||= []).push({ query: q, median_ms: times[6], p95_ms: times[11] });
  }
  let begin = performance.now();
  brain.graph.view({ limit: 350 });
  results.graph_query_ms = performance.now() - begin;
  begin = performance.now();
  brain.search.rebuild();
  results.rebuild_ms = performance.now() - begin;
  begin = performance.now();
  await brain.backups.create();
  results.backup_ms = performance.now() - begin;
  await brain.close();
  begin = performance.now();
  brain = new Brain(root);
  results.startup_ms = performance.now() - begin;
  brain.jobs.start();
  const cpu = process.cpuUsage();
  await new Promise((r) => setTimeout(r, 5000));
  const used = process.cpuUsage(cpu);
  results.idle_cpu_ms_over_5s = (used.user + used.system) / 1000;
  results.rss_mib = process.memoryUsage().rss / 1024 / 1024;
  results.integrity = brain.doctor().ok;
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(`artifacts/benchmark-${count}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await brain.close();
  removeTemporary(root);
}
