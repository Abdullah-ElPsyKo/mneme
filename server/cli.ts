#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Brain } from './app.js';
import { serve } from './api/server.js';
import { restoreBackup, verifyBackup } from './backup/backup.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    brain: { type: 'string', short: 'b' },
    port: { type: 'string' },
    dev: { type: 'boolean' },
    open: { type: 'boolean' },
    to: { type: 'string' },
    type: { type: 'string' },
    title: { type: 'string' },
    model: { type: 'boolean' },
    'cloud-consent': { type: 'boolean' },
    deep: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const help = `Mneme • local personal memory\n\nUsage: npm run brain -- <command> [arguments] [--brain DIRECTORY]\n\n  serve [--port 4589] [--open]   Run authenticated loopback UI/API\n  status                        Counts, location, queue and provider configuration\n  capture <text>                Save immediately to Inbox\n  note <text> [--title TITLE]    Create a Markdown memory\n  import <file>                 Preserve original and extract supported UTF-8 text\n  search <query>                Exact/FTS/graph search; supports type:, project:, tag:, before:\n  ask <query> [--model]          Compile cited evidence; optional configured model\n  project list                  List projects\n  graph inspect <id>            Inspect an entity and its typed relationships\n  timeline [id]                 Inspect immutable history\n  task <title>                  Create a task\n  record <type> <json>           Store a structured record\n  rebuild-index                 Rebuild disposable FTS and chunk indexes\n  reconcile                     Import external Markdown changes\n  consolidate                   Propose links and inspect conflicts\n  backup                        Create and verify snapshot\n  verify [snapshot] [--deep]     Verify snapshot or current brain\n  restore <snapshot> --to DIR   Restore into a new directory\n  doctor [--deep]                Local diagnostics without network probes\n\nMNEME_BRAIN selects storage (default .brain). MNEME_BACKUP_PASSWORD encrypts/decrypts ZIP snapshots.\nMNEME_API_KEY supplies an optional provider credential. Never pass passwords in command arguments.\nOnly one owner process can open a brain. Use the running UI/API, or stop the service before direct CLI writes.\n`;
try {
  const command = positionals[0] || 'serve',
    args = positionals.slice(1),
    root = resolve(values.brain || process.env.MNEME_BRAIN || '.brain');
  if (values.help) {
    console.log(help);
    process.exit(0);
  }
  if (command === 'restore') {
    if (!args[0] || !values.to) throw new Error('restore requires a snapshot and --to new-directory');
    console.log(
      JSON.stringify(
        await restoreBackup(resolve(args[0]), values.to, process.env.MNEME_BACKUP_PASSWORD),
        null,
        2,
      ),
    );
  } else if (command === 'verify' && args[0])
    console.log(
      JSON.stringify(await verifyBackup(resolve(args[0]), process.env.MNEME_BACKUP_PASSWORD), null, 2),
    );
  else {
    const brain = new Brain(root);
    if (command === 'serve') {
      const port = values.port ? Number(values.port) : 4589;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
      const service = await serve(brain, { port, dev: values.dev });
      console.log(
        `Mneme is running locally.\nStorage: ${root}\nOpen: ${service.url}\nKeep this session link private. Press Ctrl+C to stop.`,
      );
      if (values.open) {
        if (process.platform === 'win32')
          spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process $env:MNEME_OPEN_URL'],
            { env: { ...process.env, MNEME_OPEN_URL: service.url }, windowsHide: true, stdio: 'ignore' },
          );
        else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [service.url], { stdio: 'ignore' });
      }
      let closing = false;
      const close = async () => {
        if (closing) return;
        closing = true;
        await service.close();
        process.exit(0);
      };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
    } else {
      try {
        let result: unknown;
        if (command === 'status') result = brain.status();
        else if (command === 'capture') result = brain.ingestion.capture(args.join(' '));
        else if (command === 'note')
          result = brain.memories.save({
            title: values.title || args.join(' ').slice(0, 100),
            body: args.join(' '),
            type: values.type || 'note',
          });
        else if (command === 'import') {
          if (!args[0]) throw new Error('import requires a path');
          result = brain.ingestion.file(basename(args[0]), readFileSync(args[0]));
        } else if (command === 'search') result = brain.search.query(args.join(' '));
        else if (command === 'ask')
          result = await brain.ask(args.join(' '), values.model, values['cloud-consent']);
        else if (command === 'project' && args[0] === 'list')
          result = brain.memories.list({ type: 'project' });
        else if (command === 'graph' && args[0] === 'inspect') result = brain.graph.inspect(args[1]);
        else if (command === 'timeline') result = brain.memories.events.list({ aggregate: args[0] });
        else if (command === 'task') result = brain.structured.task({ title: args.join(' ') });
        else if (command === 'record')
          result = brain.structured.record({ type: args[0], data: JSON.parse(args.slice(1).join(' ')) });
        else if (command === 'rebuild-index') result = brain.search.rebuild();
        else if (command === 'reconcile') result = brain.memories.reconcile(true);
        else if (command === 'consolidate') {
          const batches: any[] = [];
          let batch: any;
          do {
            batch = brain.proposals.consolidate();
            batches.push(batch);
          } while (batch.more);
          result = batches;
        } else if (command === 'backup')
          result = await brain.backups.create(process.env.MNEME_BACKUP_PASSWORD);
        else if (command === 'doctor' || command === 'verify')
          result = brain.doctor(values.deep || command === 'verify');
        else throw new Error(help);
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await brain.close();
      }
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
