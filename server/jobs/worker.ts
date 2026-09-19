import { parentPort, workerData } from 'node:worker_threads';
import { Brain } from '../app.js';
import { embeddingText } from '../retrieval/evidence.js';
const brain = new Brain(workerData.root, { worker: true });
try {
  const { job } = workerData;
  let result: any;
  if (job.type === 'rebuild') result = brain.search.rebuild();
  else if (job.type === 'consolidate') {
    result = brain.proposals.consolidate();
    if (brain.settings.data.auto_accept_links)
      for (const p of brain.proposals.list())
        if (p.kind === 'relationship' && p.provenance.extraction_method === 'explicit-wikilink')
          brain.proposals.resolve(String(p.id), 'accept');
    if (result.more) brain.jobs.enqueue('consolidate');
  } else if (job.type === 'backup') result = await brain.backups.create(undefined, false);
  else if (job.type === 'embed') {
    if (!brain.settings.data.ai_background) throw new Error('Background AI is paused');
    if (!brain.provider.capabilities().local)
      throw new Error('Cloud embedding requires a foreground request and explicit consent');
    const memories = job.payload.memory_id
      ? [brain.memories.get(job.payload.memory_id)]
      : brain.memories.list({ limit: 100 });
    let count = 0;
    for (const preview of memories) {
      const m = brain.memories.get(preview.id);
      if (m.private || m.status === 'archived') continue;
      const vector = await brain.provider.embed(embeddingText(m));
      brain.search.storeVector(m, vector, brain.provider.fingerprint());
      count++;
    }
    result = { count };
  }
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({ error: (error as Error).message });
} finally {
  await brain.close();
}
