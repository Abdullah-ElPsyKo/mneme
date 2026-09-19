// Private, inherited stdio is the only desktop control channel. No control HTTP routes.
import { Brain } from './app.js';
import { serve } from './api/server.js';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shutdown') }).strict(),
  z.object({ type: z.literal('visibility'), suspended: z.boolean() }).strict(),
  z.object({ type: z.literal('toggle-background') }).strict(),
  z.object({ type: z.literal('status') }).strict(),
]);
const root = process.argv[2];
if (!root || !isAbsolute(root) || process.argv.length !== 3) {
  process.stderr.write('Desktop core requires one absolute brain directory.\n');
  process.exit(2);
}
let brain: Brain | undefined;
let service: Awaited<ReturnType<typeof serve>> | undefined;
let closing = false;
const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const shutdown = async () => {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  if (service) await service.close();
  else if (brain) await brain.close();
  process.exit(0);
};
try {
  // Readiness includes completion of existing recovery/reconciliation; no second store.
  brain = new Brain(root);
  service = await serve(brain, { port: 0, desktop: true });
  const status = () => {
    if (!closing)
      send({
        type: 'status',
        background: brain!.settings.data.background,
        suspended: brain!.jobs.desktopSuspended,
        running: brain!.jobs.running,
      });
  };
  brain.jobs.on('change', status);
  send({
    type: 'ready',
    origin: service.origin,
    token: service.token,
    root: brain.storage.root,
    pid: process.pid,
  });
  status();
  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data: string) => {
    buffer += data;
    if (buffer.length > 8192) {
      void shutdown();
      return;
    }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      chain = chain
        .then(async () => {
          if (closing) return;
          const parsed = command.safeParse(JSON.parse(line));
          if (!parsed.success) throw new Error('Invalid desktop command');
          switch (parsed.data.type) {
            case 'shutdown':
              await shutdown();
              break;
            case 'visibility':
              brain!.jobs.setDesktopSuspended(parsed.data.suspended);
              break;
            case 'toggle-background':
              brain!.settings.update({
                ...brain!.settings.data,
                background: !brain!.settings.data.background,
              });
              brain!.jobs.wake();
              brain!.jobs.emit('change');
              break;
          }
          status();
        })
        .catch(() => {
          send({ type: 'error', message: 'Desktop control command failed.' });
        });
    }
  });
  // A normal shell exit drains requests. A shell crash also closes this pipe;
  // the Windows job object is a second independent orphan-process safeguard.
  process.stdin.on('end', () => {
    void shutdown();
  });
  process.stdin.on('error', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
} catch (error) {
  send({ type: 'error', message: (error as Error).message.slice(0, 500) });
  await shutdown();
}
