import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { AppError, type Job } from '../core/types.js';
import { id, now, parse, inside } from '../core/util.js';
import type { Brain } from '../app.js';
export class Jobs extends EventEmitter {
  timer?: NodeJS.Timeout;
  watcher?: FSWatcher;
  debounce?: NodeJS.Timeout;
  worker?: Worker;
  running = false;
  stopped = true;
  desktopSuspended = false;
  setDesktopSuspended(value: boolean) {
    this.desktopSuspended = value;
    if (value && this.timer) clearTimeout(this.timer);
    if (!value) this.wake();
  }
  pendingFiles = new Set<string>();
  constructor(readonly brain: Brain) {
    super();
  }
  enqueue(type: string, payload: any = {}, dedupKey?: string) {
    if (!['rebuild', 'consolidate', 'embed', 'backup', 'reconcile'].includes(type))
      throw new AppError(400, 'Unsupported background job');
    const db = this.brain.storage.db;
    const existing = dedupKey
      ? db.prepare("SELECT * FROM jobs WHERE dedup_key=? AND status IN ('queued','running')").get(dedupKey)
      : null;
    if (existing) return this.decode(existing);
    if (
      Number(db.prepare("SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')").get()!.n) >=
      1000
    )
      throw new AppError(429, 'Background queue is full');
    const job = {
      id: id(),
      type,
      payload,
      status: 'queued',
      attempts: 0,
      created_at: now(),
      updated_at: now(),
      run_at: now(),
      error: null,
    };
    db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      job.id,
      type,
      JSON.stringify(payload),
      'queued',
      0,
      job.created_at,
      job.updated_at,
      job.run_at,
      null,
      dedupKey || null,
    );
    this.wake();
    return job;
  }
  decode(row: any): Job {
    return { ...row, payload: parse(row.payload) };
  }
  list() {
    return this.brain.storage.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100')
      .all()
      .map((row) => this.decode(row));
  }
  retry(jobId: string) {
    this.brain.storage.db
      .prepare(
        "UPDATE jobs SET status='queued',attempts=0,run_at=?,error=NULL WHERE id=? AND status='failed'",
      )
      .run(now(), jobId);
    this.wake();
  }
  start() {
    this.stopped = false;
    this.brain.storage.db
      .prepare("UPDATE jobs SET status='queued',run_at=? WHERE status='running'")
      .run(now());
    this.watcher = watch(
      inside(this.brain.storage.root, 'vault'),
      { recursive: true },
      (_event, filename) => {
        if (!filename || !String(filename).endsWith('.md')) return;
        if (this.pendingFiles.size < 1000)
          this.pendingFiles.add(`vault/${String(filename).replaceAll('\\', '/')}`);
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.reconcilePending(), 500);
      },
    );
    this.watcher.on('error', () =>
      this.brain.storage.state('watcher_error', 'Filesystem watcher unavailable; use Reconcile or restart'),
    );
    this.wake();
  }
  reconcilePending() {
    if (!this.brain.settings.data.background || this.stopped || this.desktopSuspended) return;
    for (const file of this.pendingFiles) {
      try {
        this.brain.memories.reconcileFile(file, true);
      } catch (e) {
        this.brain.storage.state('watcher_error', (e as Error).message);
      }
    }
    this.pendingFiles.clear();
  }
  wake() {
    if (this.timer) clearTimeout(this.timer);
    if (this.running || this.stopped || this.desktopSuspended || !this.brain.settings.data.background) return;
    this.timer = setTimeout(() => void this.tick(), 20);
  }
  async tick() {
    if (this.brain.storage.db.prepare('SELECT 1 FROM erasure_cleanup').get()) return;
    if (this.running || this.stopped || this.desktopSuspended || !this.brain.settings.data.background) return;
    this.reconcilePending();
    const { storage, settings } = this.brain;
    for (const [type, hours] of [
      ['backup', settings.data.backup_interval_hours],
      ['consolidate', settings.data.consolidation_interval_hours],
    ] as const) {
      if (!hours) continue;
      const last = storage.state(`scheduled_${type}`) || now();
      if (!storage.state(`scheduled_${type}`)) storage.state(`scheduled_${type}`, last);
      if (Date.now() - Date.parse(last) >= hours * 3600000) {
        this.enqueue(type, {}, `scheduled:${type}`);
        storage.state(`scheduled_${type}`, now());
      }
    }
    const row = storage.db
      .prepare(
        `SELECT * FROM jobs WHERE status='queued' AND run_at<=? ${settings.data.ai_background ? '' : "AND type!='embed'"} ORDER BY created_at LIMIT 1`,
      )
      .get(now());
    if (!row) {
      const next = storage.db
        .prepare(
          `SELECT min(run_at) AS at FROM jobs WHERE status='queued' ${settings.data.ai_background ? '' : "AND type!='embed'"}`,
        )
        .get() as any;
      const delay = next.at ? Math.max(100, Date.parse(next.at) - Date.now()) : 3600000;
      // One maintenance wake per hour when there is no queued work.
      this.timer = setTimeout(() => void this.tick(), Math.min(delay, 3600000));
      return;
    }
    const job = this.decode(row);
    this.running = true;
    storage.db
      .prepare("UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?")
      .run(now(), job.id);
    this.emit('change');
    try {
      if (job.type === 'reconcile') this.brain.memories.reconcile(true);
      else if (job.type === 'backup') {
        const result = this.brain.memories.reconcile(true);
        if (result.errors.length) throw new Error('Resolve vault reconciliation errors before backup');
        await this.executeWorker(job);
      } else await this.executeWorker(job);
      storage.db
        .prepare("UPDATE jobs SET status='done',updated_at=?,error=NULL WHERE id=?")
        .run(now(), job.id);
    } catch (error) {
      const attempt = job.attempts + 1,
        retry = attempt < 4;
      storage.db
        .prepare('UPDATE jobs SET status=?,updated_at=?,run_at=?,error=? WHERE id=?')
        .run(
          retry ? 'queued' : 'failed',
          now(),
          new Date(Date.now() + Math.min(300000, 2000 * 2 ** attempt)).toISOString(),
          (error as Error).message.slice(0, 500),
          job.id,
        );
    } finally {
      this.worker = undefined;
      this.running = false;
      this.emit('change');
      this.wake();
    }
  }
  executeWorker(job: Job) {
    return new Promise((resolve, reject) => {
      const production = import.meta.url.endsWith('.js');
      const entry = new URL(production ? './worker.js' : './worker.ts', import.meta.url);
      this.worker = production
        ? new Worker(entry, { workerData: { root: this.brain.storage.root, job } })
        : new Worker(
            `const { register } = require('tsx/esm/api'); register(); import(${JSON.stringify(entry.href)});`,
            { eval: true, workerData: { root: this.brain.storage.root, job } },
          );
      let settled = false;
      this.worker.once('message', (message) => {
        settled = true;
        message.error ? reject(new Error(message.error)) : resolve(message.result);
      });
      this.worker.once('error', reject);
      this.worker.once('exit', (code) => {
        if (!settled) reject(new Error(`Worker stopped (${code})`));
      });
    });
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    // Finish the current bounded job before closing database handles.
    if (this.worker) await new Promise<void>((resolve) => this.worker!.once('exit', () => resolve()));
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
