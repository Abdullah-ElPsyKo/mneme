# Mneme

**A local home for your memory.** Notes, decisions, projects, tasks, original evidence, and a graph you can inspect. AI is optional.

Mneme runs on your computer. Human-readable Markdown, SQLite, and original files remain yours. It does not require an account, send telemetry, or contact a model unless you enable and request it.

## Start here

Install **Mneme_0.2.3_x64-setup.exe**, then open **Mneme** from the Windows Start Menu. The Tauri 2 desktop application includes its own memory engine and Node runtime. It needs no browser, terminal, npm command, or separate Node installation. WebView2 is supplied by Windows; the installer can install it if missing (that prerequisite download requires internet).

First launch offers a recommended brain folder, another empty folder, or an existing Mneme brain. The recommended location is **`%LOCALAPPDATA%\MnemeBrains\Default`**, separate from the installation and disposable application settings. Existing brains stay where they are. Uninstalling the app preserves brain folders.

**Settings → Desktop** controls closing, tray mode, background work while hidden, Windows autostart, and the global capture shortcut. **Ctrl+Alt+Space** opens the small capture window; a shortcut conflict is reported so you can choose another. **F11** toggles fullscreen. Closing defaults to asking whether to exit or keep Mneme in the tray.

This build is unsigned. No automatic updater is enabled. See [desktop architecture, building, and signing](docs/desktop.md) and [desktop verification](docs/desktop-verification.md).

Item deletion defaults to recoverable archival. Memories also have a separate **Delete permanently** action, multiple structured facts, and a searchable supersession picker. See [lifecycle semantics, limits, and verification](docs/deletion.md).

Ask selects relevant evidence, includes explicit memory status and facts, and offers collapsed sources, durable New Chat/history, and streaming scroll controls. See [Ask behavior, targeted tests and diagnostics](docs/ask-quality.md).

### Browser development workflow

Developers can still use **Node.js 24.14 or newer** and a current desktop browser. Internet access is needed to install npm dependencies; the built app works offline.

```powershell
npm ci
npm run build
npm start -- --open
```

For browser development, double-click **`start-brain.cmd`** after building. The service prints a private session link and opens the browser. Keep the terminal running; Ctrl+C stops it. This launcher is separate from the installed desktop app.

In browser development, data defaults to **`.brain` inside this repository**. Choose another location explicitly:

```powershell
npm start -- --brain "C:\Users\you\Documents\MyBrain" --open
```

The service binds to **127.0.0.1:4589**. Use `--port 4591` for another port. `MNEME_BRAIN` can set the default directory. The first launch explains storage, privacy, and backups. The fresh brain contains no sample data.

## Everyday use

- **Quick capture:** press **Ctrl+Shift+Space** while the app is focused. Write a thought and press Ctrl+Enter. It lands in Inbox.
- **Create a note:** Ctrl+N, or New memory. Markdown supports headings, lists, code, tables, and `[[Entity name]]` references. Ctrl+Enter saves a revision.
- **Find anything:** Ctrl+K opens the keyboard command/search palette. Type `>` for commands.
- **Connect knowledge:** create a structured entity from the graph toolbar, or create a project/note. Open its inspector → Connections → + to record a typed relationship.
- **Review suggestions:** Inbox → Find connections proposes unambiguous wiki links. Accept, edit, or reject them. Settings can auto-accept this narrow class of explicit links.
- **Inspect history:** open any memory → History. Restore an earlier version as a new revision. Timeline can show the graph at a historical time.
- **Keep originals:** drag files into the app or use Import. Sources downloads the exact bytes originally imported.
- **Ask:** evidence mode retrieves cited memories locally. Enable a configured model explicitly for a generated answer. Ask history and the source revisions used are stored in SQLite; answers do not become confirmed memories.
- **Back up:** Settings → Backups → Back up now. Add a passphrase for encrypted snapshots; test a restore into a new directory.

## Search

Search combines SQLite FTS5, exact text, entity matches, graph neighbors, authority, project affinity, importance, and recency. Optional embeddings add a semantic channel. Weighted reciprocal rank fusion combines channels; exact strings receive a strong boost.

```text
FORGELINE RDP
"FL - Allow RDP TCP from MGMT"
project:FORGELINE type:decision
project:"Home lab" tag:windows
before:2026-09-01 GPU
after:2026-08-01 class:episodic
entity:FORGELINE
source:architecture.md
status:archived
```

`before:` is exclusive; `after:` is inclusive. Dates filter the memory's update time. Exact phrases are mandatory matches. The search UI can display historical/superseded documents; Ask excludes explicitly superseded facts and private memories. Historical revision exploration is available through Timeline and the inspector.

## Storage and architecture

```text
brain/
  vault/          Canonical Markdown with YAML frontmatter
  database/       brain.db: structured memory, history, provenance, durable queue
  objects/        Immutable original bytes, addressed by SHA-256
  indexes/        Disposable FTS5, chunks, vectors, file-stat cache
  config/         Non-secret settings; Windows DPAPI-protected credential blob
  backups/        Verified ZIP snapshots
  logs/           Bounded local diagnostic log, without memory or model payloads
```

The TypeScript modular monolith separates storage, memories, graph, retrieval, context, models, jobs, backup, API, and CLI. The React UI has no filesystem or SQL access. A Canvas graph caps the visible working set, uses cluster summaries at distant zoom, culls off-screen nodes, and stops rendering while idle.

Each semantic edit commits an immutable revision and pending file write in SQLite before atomically materializing Markdown. Startup replays interrupted writes and preserves unexpected external bytes as recovery evidence. SQLite uses WAL, full synchronous canonical writes, foreign keys, migrations, and a bounded busy timeout. An exclusive owner lock prevents independent CLI/service writers; worker threads use the owner's internal queue.

External Markdown edits are detected by filesystem notifications and startup reconciliation. A disposable size/mtime/hash cache avoids parsing unchanged files. Use Doctor's deep check to detect edits that deliberately preserve timestamps. Deleting a Markdown file archives its committed content and preserves history. Unknown imported frontmatter remains in original evidence; the normalized vault file uses the supported schema.

See [architecture](docs/architecture.md), [ADRs](docs/adr/), [security review](docs/security-review.md), [verification](docs/verification.md), and [limitations](docs/limitations.md).

## AI and privacy

The default is **AI disabled + Local only**. Search, files, notes, graph, tasks, and history work without it.

In Settings → Privacy & AI:

| Provider                    | Endpoint example                                     | Model                             |
| --------------------------- | ---------------------------------------------------- | --------------------------------- |
| Ollama                      | `http://127.0.0.1:11434`                             | An installed Ollama model name    |
| OpenAI-compatible local API | `http://127.0.0.1:8080/v1`                           | The model served by that endpoint |
| Compatible external API     | Provider HTTPS base URL, including `/v1` when needed | Provider model identifier         |

Local-only mode accepts loopback endpoints and rejects redirects. External providers require turning local-only off, HTTPS, and consent for **each** request. The request contains the question and bounded selected evidence, not the entire vault. A private-memory checkbox excludes a memory from AI context and embeddings. Models have no tools or write authority. Imported text is always untrusted data. Prompt injection cannot be perfectly solved through prompts; the enforceable protection is that the model has no execution capability.

The adapter implements generation, streaming, capability reporting, and embedding. Configure an embedding model and enable Background AI to queue local embedding work. The initial batch covers up to 100 recent memories; per-memory jobs are also available through the API. Provider fingerprints and revision hashes prevent mixing incompatible or stale vectors.

On Windows, Protect key uses **DPAPI CurrentUser**; the key is passed over stdin and only the encrypted blob is saved. Other platforms use the `MNEME_API_KEY` environment variable supplied by your OS secret manager. Never commit `.env` files or put a key in settings JSON. DPAPI blobs are intentionally excluded from backups. Restored brains start with AI disabled and local-only enabled.

## Backup and recovery

Backups use SQLite's online backup API. Markdown is reconstructed from the snapshot's immutable revisions so foreground edits cannot produce mismatched generations. Original objects are hash-checked. Every archive includes a SHA-256 manifest and is fully verified before being retained. Settings controls destination, retention, and optional scheduled **unencrypted** local backups.

Encrypted snapshots use zip.js's standard **WinZip AES-256** format, not custom encryption. Use a long, unique passphrase. Archive filenames are visible. This format's password derivation is weaker against password guessing than modern dedicated backup formats; strong passphrases matter. Windows Explorer may not open AES-encrypted ZIPs; use Mneme restore or a compatible archiver.

```powershell
# Stop the service before direct CLI access to the same brain.
npm run brain -- backup --brain "C:\Users\you\Documents\MyBrain"
npm run brain -- verify "C:\path\snapshot.zip"
npm run brain -- restore "C:\path\snapshot.zip" --to "C:\path\RestoredBrain"
npm run brain -- doctor --deep --brain "C:\path\RestoredBrain"
```

Set `MNEME_BACKUP_PASSWORD` in the process environment to encrypt or decrypt with the CLI; do not pass passwords on the command line. Restore requires a new destination and rejects traversal, unexpected members, oversized archives, wrong passwords, bad hashes, or SQLite integrity failures. Existing brains are never overwritten. Indexes regenerate after restore.

The active vault/database are **not encrypted by Mneme**. Use full-disk encryption and OS account protection. Keep backups on another physical device as well: a snapshot on the same disk cannot protect against disk loss. See [recovery runbook](docs/recovery.md).

## CLI and API

```powershell
npm run brain -- --help
npm run brain -- status
npm run brain -- capture "DC02 DNS failover validated."
npm run brain -- import "C:\path\architecture.md"
npm run brain -- search 'project:FORGELINE RDP'
npm run brain -- ask 'Why is RDP restricted?'
npm run brain -- ask 'Why is RDP restricted?' --model
npm run brain -- project list
npm run brain -- graph inspect ENTITY_ID
npm run brain -- timeline MEMORY_ID
npm run brain -- task "Test the restore procedure"
npm run brain -- record measurement '{"metric":"temperature","value":23.2,"unit":"C"}'
npm run brain -- reconcile
npm run brain -- rebuild-index
npm run brain -- consolidate
```

The CLI and GUI share application services. Stop the service before direct CLI commands against that brain; while the service is running, integrations should use its authenticated API. [API documentation](docs/api.md) includes request examples and error behavior.

## Development and verification

```powershell
npm run dev                   # Vite middleware + local service
npm run build                 # Type-check server/UI; build local production assets
npm test                      # Unit and integration tests
npm run test:e2e              # End-to-end workflows in locally installed Microsoft Edge
npm run bench -- 1000
npm run bench -- 10000
npm run format:check
npm run desktop:runtime       # Download and verify pinned build-time runtime
npm run desktop:dev           # Native shell with the current React/core build
npm run desktop:build         # Windows x64 NSIS installer
```

E2E tests use isolated disposable brains. They exercise the built application, including actual disk persistence and snapshot restore. Tests never use the default personal `.brain`. `scripts/preview.ts` creates a clearly labeled test dataset in `.test-brains/visual-review`; it is solely a development review fixture.

Build and test results, performance measurements, security findings, and unverified boundaries are recorded in [verification](docs/verification.md). This is a tested initial release, not a claim of years of field reliability or a substitute for independent backups.
