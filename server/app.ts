import { taskEvidence } from './retrieval/structured.js';
import { existsSync, readFileSync, mkdirSync, realpathSync, statSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Storage } from './storage/database.js';
import { acquireLock } from './storage/lock.js';
import { Memories } from './memory/memories.js';
import { Structured } from './memory/structured.js';
import { Graph } from './graph/graph.js';
import { Proposals } from './memory/proposals.js';
import { Ingestion } from './ingestion/ingestion.js';
import { Search } from './retrieval/search.js';
import { compileContext, citationWarning } from './context/compiler.js';
import { Settings } from './security/settings.js';
import { HttpModelProvider } from './models/provider.js';
import { Backups } from './backup/backup.js';
import { Jobs } from './jobs/jobs.js';
import { Conversations } from './memory/conversations.js';
import { Deletion } from './memory/deletion.js';
import { activeObject } from './memory/lifecycle.js';
import { recoverErasure } from './memory/erasure.js';
import { hash, inside, now } from './core/util.js';
import { selectEvidence } from './retrieval/evidence.js';
import { askSystem, noRecordedAnswer } from './context/style.js';
export class Brain {
  readonly storage: Storage;
  readonly memories: Memories;
  readonly structured: Structured;
  readonly graph: Graph;
  readonly proposals: Proposals;
  readonly ingestion: Ingestion;
  readonly search: Search;
  readonly settings: Settings;
  readonly provider: HttpModelProvider;
  readonly backups: Backups;
  readonly jobs: Jobs;
  readonly conversations: Conversations;
  readonly deletion: Deletion;
  release?: () => void;
  constructor(root: string, options: { worker?: boolean; skipReconcile?: boolean } = {}) {
    mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
    root = realpathSync(resolve(root));
    mkdirSync(inside(root, 'database'), { recursive: true, mode: 0o700 });
    if (!options.worker) {
      this.release = acquireLock(root);
    }
    let opened: Storage | undefined;
    try {
      this.storage = opened = new Storage(root);
      this.memories = new Memories(this.storage);
      this.structured = new Structured(this.storage);
      this.graph = new Graph(this.storage);
      this.proposals = new Proposals(this.memories, this.graph);
      this.ingestion = new Ingestion(this.memories);
      this.search = new Search(this.memories);
      this.settings = new Settings(this.storage.root);
      this.provider = new HttpModelProvider(this.settings);
      this.backups = new Backups(this.memories, this.settings);
      this.jobs = new Jobs(this);
      this.conversations = new Conversations(this.storage);
      this.deletion = new Deletion(this);
      if (!options.worker)
        recoverErasure(this.storage, () => {
          this.memories.flush();
          this.search.rebuild();
        });
      this.memories.onChange = (memoryId) => {
        try {
          this.search.index(memoryId);
        } catch (error) {
          this.storage.state('index_error', (error as Error).message);
        }
        this.jobs.emit('change');
      };
      if (!options.worker && !options.skipReconcile) {
        this.memories.reconcile();
        this.search.syncMissing();
        this.conversations.recover();
      }
    } catch (error) {
      opened?.close();
      this.release?.();
      throw error;
    }
  }
  status() {
    const db = this.storage.db;
    const count = (table: string, condition = '') =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${condition}`).get()!.n);
    return {
      name: this.settings.data.name,
      root: this.storage.root,
      local_only: this.settings.data.local_only,
      provider: this.provider.capabilities(),
      background: this.settings.data.background,
      memories: count('memories', "WHERE status!='archived'"),
      entities: count(
        'entities',
        `WHERE ${activeObject('entity', 'entities.id')} AND (memory_id IS NULL OR memory_id IN (SELECT id FROM memories WHERE status!='archived'))`,
      ),
      relationships: count('relationships', 'WHERE valid_until IS NULL'),
      events: count('events'),
      sources: count('sources', `WHERE ${activeObject('source', 'sources.id')}`),
      tasks: count('tasks', `WHERE status IN ('open','doing') AND ${activeObject('task', 'tasks.id')}`),
      inbox: count('memories', "WHERE status='inbox'"),
      proposals: count('proposals', "WHERE status='pending'"),
      queued_jobs: count('jobs', "WHERE status IN ('queued','running')"),
      last_backup: this.backups.list()[0] || null,
      consolidation: this.storage.state('consolidation'),
      reconciliation: this.storage.state('reconciliation'),
      watcher_error: this.storage.state('watcher_error'),
    };
  }
  doctor(deep = false) {
    const integrity = this.storage.db.prepare('PRAGMA integrity_check').get()!.integrity_check;
    const foreignKeys = this.storage.db.prepare('PRAGMA foreign_key_check').all();
    const pending = Number(this.storage.db.prepare('SELECT count(*) AS n FROM outbox').get()!.n);
    const missing: string[] = [],
      damaged: string[] = [];
    for (const row of this.storage.db.prepare('SELECT id,path,content_hash FROM memories').iterate()) {
      const path = inside(this.storage.root, String(row.path));
      if (!existsSync(path)) missing.push(String(row.path));
      else if (deep && hash(readFileSync(path)) !== row.content_hash) damaged.push(String(row.path));
    }
    if (deep)
      for (const row of this.storage.db.prepare('SELECT hash FROM sources').iterate()) {
        const path = this.memories.objects.path(String(row.hash));
        if (!existsSync(path)) missing.push(String(row.hash));
        else if (hash(readFileSync(path)) !== row.hash) damaged.push(String(row.hash));
      }
    const canonical = Number(this.storage.db.prepare('SELECT count(*) AS n FROM memories').get()!.n),
      indexed = Number(this.storage.index.prepare('SELECT count(*) AS n FROM indexed').get()!.n);
    const stale = Number(
      this.storage.index
        .prepare(
          'SELECT count(*) AS n FROM canonical.memories m LEFT JOIN indexed i ON i.id=m.id WHERE i.id IS NULL OR i.hash!=m.content_hash',
        )
        .get()!.n,
    );
    let fts = 'ok';
    try {
      this.storage.index.exec("INSERT INTO documents(documents) VALUES('integrity-check')");
    } catch {
      fts = 'failed';
    }
    return {
      ok:
        integrity === 'ok' &&
        !foreignKeys.length &&
        !missing.length &&
        !damaged.length &&
        !pending &&
        fts === 'ok' &&
        canonical === indexed &&
        !stale,
      sqlite: integrity,
      foreign_keys: foreignKeys,
      pending_writes: pending,
      missing,
      damaged,
      fts,
      indexed,
      stale,
      canonical,
      vector_count: this.storage.index.prepare('SELECT count(*) AS n FROM vectors').get()!.n,
      provider: this.provider.capabilities(),
      background: this.settings.data.background,
      root: this.storage.root,
      note: 'Provider status is configuration only; no network probe is performed.',
    };
  }
  async context(
    query: string,
    semantic = false,
    cloudConsent = false,
    budget = this.settings.data.context_budget,
  ) {
    let vector: number[] | undefined, warning: string | undefined;
    if (semantic && this.provider.capabilities().embed)
      try {
        vector = await this.provider.embed(query, cloudConsent);
      } catch (e) {
        warning = (e as Error).message;
      }
    const hits = this.search.query(query, {
      limit: 200,
      ask: true,
      includePrivate: false,
      vector,
      provider: this.provider.fingerprint(),
    });
    const superseded = new Set(
      this.storage.db
        .prepare(
          "SELECT supersedes FROM memories WHERE supersedes IS NOT NULL AND status!='archived' AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)",
        )
        .all(now(), now())
        .map((row) => String(row.supersedes)),
    );
    const eligible = hits.filter(
      (h) => !superseded.has(h.memory.id) && h.memory.status !== 'archived' && !h.memory.private,
    );
    const selected = selectEvidence(query, eligible);
    const context = compileContext(
      query,
      selected.hits,
      budget,
      superseded,
      taskEvidence(this.storage, query),
    );
    context.omitted.push(
      ...selected.omitted,
      ...hits
        .filter((h) => superseded.has(h.memory.id))
        .map((h) => ({ id: h.memory.id, reason: 'explicitly superseded' })),
    );
    const diagnostics = {
      candidate_count: hits.length,
      selected_count: selected.hits.length,
      evidence_count: context.evidence.length,
      context_tokens: context.estimated_tokens,
    };
    return { context, hits, warning, diagnostics };
  }
  async ask(
    query: string,
    useModel = false,
    cloudConsent = false,
    semantic = false,
    conversationId = this.conversations.current(),
  ) {
    const retrieval = await this.context(query, semantic, cloudConsent);
    const turn = this.conversations.begin(
      query,
      retrieval.context,
      useModel ? this.settings.data.model : null,
      conversationId,
    );
    if (!useModel) {
      this.conversations.finish(turn.id, '');
      return { ...retrieval, answer: null, mode: 'evidence' };
    }
    if (!retrieval.context.evidence.length) {
      this.conversations.finish(turn.id, noRecordedAnswer);
      return { ...retrieval, answer: noRecordedAnswer, mode: 'evidence' };
    }
    try {
      const answer = await this.provider.generate({
        system: askSystem,
        prompt: retrieval.context.prompt,
        cloudConsent,
      });
      const warning = citationWarning(answer, retrieval.context) || retrieval.warning;
      this.conversations.finish(turn.id, answer, warning);
      return { ...retrieval, answer, mode: 'model', warning };
    } catch (error) {
      this.conversations.finish(turn.id, '', (error as Error).message);
      return { ...retrieval, answer: null, mode: 'evidence', warning: (error as Error).message };
    }
  }
  log(event: string, data: Record<string, unknown> = {}) {
    const path = inside(this.storage.root, 'logs/service.jsonl');
    // Deliberately omit queries, evidence, provider payloads, request bodies and secrets.
    if (existsSync(path) && statSync(path).size > 2_000_000) return;
    appendFileSync(path, JSON.stringify({ at: now(), event, ...data }) + '\n', { mode: 0o600 });
  }
  async close() {
    await this.jobs.stop();
    this.storage.close();
    this.release?.();
  }
}
