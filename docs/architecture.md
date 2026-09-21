# Mneme — architecture

## Product boundary

Mneme is an offline personal memory application. A Tauri 2 native Windows shell hosts the existing React interface. A supervised, bundled Node 24 core owns a local brain directory and serves the unchanged authenticated application API on a random loopback port internal to the app. A private stdio channel carries readiness and lifecycle controls. No hosted service, account, telemetry, browser, separately installed Node runtime, or AI provider is required. The browser development workflow and CLI remain available and use the same application services. See [ADR 0004](adr/0004-tauri-desktop-and-bundled-core.md) and [desktop architecture](desktop.md).

## Canonical storage and recovery

- `vault/<id>.md`: readable UTF-8 Markdown with YAML frontmatter; canonical semantic content.
- `database/brain.db`: structured entities, relationships, tasks, append-only events, provenance, source manifests, durable jobs, and file-write outbox. WAL, foreign keys, full synchronous writes, migrations, and bounded busy timeout.
- `objects/<sha256-prefix>/<sha256>`: immutable original imports, addressed by SHA-256.
- `indexes/search.db`: disposable FTS5 documents, chunks, and optional vectors. Never stores the only copy of a memory.
- `config/settings.json`: non-secret preferences. API session secrets stay in process memory; provider keys come from OS credential storage or environment.
- `backups/`: verified snapshots. Backup manifests include every canonical file hash; SQLite backup uses the SQLite snapshot API. Restore validates all entries and hashes into a new directory.

A semantic edit commits an event carrying the full revision and a pending file write in one SQLite transaction. An atomic, flushed replacement materializes the Markdown. Recovery drains the outbox; reads never silently treat an older file as a newer revision. Reconciliation detects external edits by content hash and records their origin. Event triggers prohibit application-level update/delete of history. This is audit history and recovery, not a promise of tamper resistance against the machine owner.

## Application modules

`storage` / `memory` / `ingestion` / `retrieval` / `context` / `models` / `jobs` / `backup` / `security` / `api` / `cli` form explicit server boundaries. UI code cannot access the filesystem or SQL. Parameterized SQL and validated commands are the write boundary. Stable UUID identifiers and UTC ISO timestamps support future export and synchronization.

## Retrieval and model boundary

Exact lexical matches, FTS5, graph adjacency, entity matches, metadata, authority, recency, project affinity, and optional embedding similarity feed weighted reciprocal rank fusion. Context compilation is separate: it budgets conservative token estimates, deduplicates evidence, resolves explicitly superseded memories, detects explicit fact conflicts, and emits source citations. Imported evidence is untrusted data. Models have no tools or direct memory writes. Model suggestions become reviewable proposals. Local-only mode rejects non-loopback model endpoints and redirects; cloud use requires an explicit settings change and a per-request consent flag.

## Background work

The exclusive owner lock is acquired before opening storage. Constructor failures release it. Shutdown closes incoming connections, aborts streaming model work, drains asynchronous request handlers, and waits for the current worker before closing SQLite. Ask turns retain selected evidence revisions and partial answers; interrupted turns are marked on recovery.

Reconciliation uses a disposable file size/mtime/hash cache at startup; filesystem notifications always hash the changed file. Deep Doctor checks rehash the vault and object store. Retrieval applies metadata filters inside the FTS query, batches candidate hydration, and rejects stale revision hashes for vectors. Doctor checks both index counts and revision hashes.

One durable bounded queue uses event-driven wakeups, retry backoff, crash recovery, and observable job state. Filesystem notifications are debounced. Startup reconciles files; idle operation does not rescan the whole vault. Background processing and background AI have separate controls. Heavy rebuild and embedding tasks run in a worker thread so HTTP and rendering remain responsive.

## Presentation

Projects have a separate `project_state` lifecycle: planned, active, paused,
completed, abandoned. Memory status still governs inbox/archive visibility. A
lifecycle edit uses the existing memory transaction, event and outbox path, changes
only that project, and preserves label-based associations and independent child
memory/task statuses. The Projects view combines lifecycle filtering with existing
metadata queries. Planned is the creation default; only lifecycle-active projects
represent current work in project overview retrieval. Schema 6 derives conservative
legacy defaults without rewriting canonical Markdown or past events.

The primary space is a stable, clustered canvas graph of real entities and relationships. Overview clusters derive from entity types. Zoom progressively reveals members; focus isolates actual neighbors. A right-hand inspector and Ask pane retain graph context. Notes, projects, timeline, inbox, tasks, sources, and settings share reusable typography, surfaces, controls, and keyboard behavior. Empty brains stay empty until the user captures or imports information.

## Verification

Unit/integration tests cover storage recovery, migrations, temporal history, provenance, FTS/ranking, context budgeting, import deduplication, proposals, privacy, API attacks, durable jobs, encryption, backup verification, and restore. Browser tests cover creation, editing, search, provenance, tasks, sources, settings, and restart persistence. Benchmarks measure 1,000 and 10,000 memories plus startup, search, rebuild, backup, and idle CPU. Results and material limitations are recorded separately from intended targets.
