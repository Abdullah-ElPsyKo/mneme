# Local API

Base URL: `http://127.0.0.1:4589/api`. The host and port must match the local service. The service never binds a public interface.

## Authentication

The service generates an in-memory 256-bit session key at launch. Its printed UI link contains the key in a URL fragment; fragments are not HTTP request paths. The UI exchanges it with `POST /session {"token":"..."}` for an HttpOnly, SameSite=Strict cookie, then immediately removes the fragment. Cookies expire after seven days and are invalidated on service restart. The master session key is not persisted.

Integrations may send `Authorization: Bearer <session-key>`. Treat this key like access to the complete brain. No external origin or wildcard CORS is permitted. Cross-site browser requests and unexpected Host headers are rejected. Plain loopback HTTP is intentional; do not put this service behind a public proxy.

## Conventions

Requests with bodies require `Content-Type: application/json`. Unknown mutation fields are rejected. Errors use `{ "error": "..." }` with 400 validation, 401 authentication, 403 privacy/origin, 404 missing, 409 conflict, 413 size, 429 queue capacity, or 5xx operation/provider errors. No request bodies, memory text, or credentials are written to diagnostics.

List endpoints accept `limit` and `offset` (bounded server-side). Dates are UTC ISO timestamps unless an endpoint explicitly expects YYYY-MM-DD. IDs are stable UUIDs. SQL values are parameterized.

## Endpoints

| Method     | Path                    | Purpose / body                                                                    |
| ---------- | ----------------------- | --------------------------------------------------------------------------------- |
| GET        | `/status`               | Counts, storage, queue, privacy and provider configuration                        |
| GET / PUT  | `/settings`             | Read or replace validated non-secret settings                                     |
| PUT        | `/settings/key`         | `{ "key": "..." }`, OS-protected on Windows                                       |
| GET        | `/memories`             | Filter by `type`, `project`, `status`; `archived=true` includes archived          |
| POST       | `/memories`             | Create memory; required `title`, optional `body`, metadata, provenance            |
| GET        | `/memories/:id`         | Full current memory; `at=ISO_TIMESTAMP` returns a historical revision             |
| PUT        | `/memories/:id`         | Full validated memory input plus `expected_version`                               |
| POST       | `/capture`              | `{ "text": "A thought" }` → Inbox capture                                         |
| POST       | `/import`               | `{ "name": "file.md", "content": "BASE64", "mime": "text/markdown" }`             |
| GET        | `/search?q=...`         | Fused ranked hits with signals, excerpts and provenance                           |
| POST       | `/context`              | `{ "query": "...", "semantic": false, "cloud_consent": false }`                   |
| POST       | `/ask`                  | Query body, optional `use_model`; cited evidence and optional answer              |
| POST       | `/ask/stream`           | Same input; SSE `context`, `token`, `warning`, `done` events                      |
| GET        | `/ask/history`          | Stored questions, answers, and exact selected evidence revisions                  |
| GET        | `/graph`                | Bounded subgraph; `focus`, `type`, `at`, `limit`, `offset`                        |
| POST       | `/entities`             | `{ "name": "MGMT01", "type": "device", "properties": {} }`                        |
| GET        | `/entities/:id`         | Entity, live/ended typed relationships, provenance                                |
| POST       | `/relationships`        | `{ "from_id": "...", "to_id": "...", "type": "uses" }`                            |
| DELETE     | `/relationships/:id`    | End validity and append history; preserve row                                     |
| GET        | `/events`               | `aggregate`, `before`, `after`, pagination                                        |
| GET / POST | `/tasks`                | Task list / create; title, status, project, due_at, memory_id                     |
| PUT        | `/tasks/:id`            | Task update with `expected_version`                                               |
| GET / POST | `/records`              | Extensible structured records; type, data, provenance, valid interval, supersedes |
| GET / POST | `/proposals`            | List by status / create `memory` or `relationship` proposal                       |
| POST       | `/proposals/:id`        | `action`: `accept` or `reject`; optional `edited` payload                         |
| GET        | `/sources`              | Original object manifests and extraction capabilities                             |
| GET        | `/sources/:id/download` | Exact original, forced attachment download                                        |
| GET / POST | `/jobs`                 | Status / enqueue `rebuild`, `reconcile`, `consolidate`, `embed`, `backup`         |
| POST       | `/jobs/:id/retry`       | Requeue failed job                                                                |
| GET        | `/doctor?deep=true`     | Hash, SQLite, foreign key, file and FTS checks                                    |
| GET / POST | `/backups`              | Snapshot list / create; optional `password` (12+ characters)                      |
| GET        | `/backups/:id/download` | Download a recorded snapshot                                                      |
| POST       | `/backups/verify`       | `{ "id": "...", "password": "optional" }`                                         |
| POST       | `/backups/restore`      | `{ "id": "...", "destination": "new directory", "password": "optional" }`         |
| GET        | `/live`                 | SSE notifications for background/external-file changes, no polling                |

Memory classes: `semantic`, `episodic`, `procedural`, `working`, `preference`. Memory statuses: `active`, `inbox`, `archived`, `completed`. Task statuses: `open`, `doing`, `done`, `cancelled`. Memory/entity/relationship types are extensible lowercase identifiers.

Project memories additionally carry `project_state`: `planned`, `active`, `paused`,
`completed`, or `abandoned`. It is independent of memory visibility/archive status.
Set it during creation or a normal version-checked memory PUT. New projects default
to planned (an explicit legacy `status: completed` still defaults to completed).
Omitting lifecycle during an update preserves its current value. Non-project
memories cannot carry a non-null project lifecycle.

Both `/memories` and `/search` accept `project_state` alongside their existing
filters; search text also supports `project_state:paused`. Completed and abandoned
projects remain available unless explicitly archived. Ask evidence includes the
project lifecycle, and its project `status` reflects lifecycle rather than visibility.

Schema migration 6 preserves existing active/completed classifications. Inbox
projects become planned. Archived projects recover the last recorded non-archived
active/completed state, falling back to planned when none is recorded. The migration
does not rewrite Markdown, historical events, provenance, versions, or associated
memories. Subsequent edits record lifecycle in both Markdown and revision history.
An archived project retains its lifecycle when restored. Older binaries refuse
schema 6 brains; use a pre-upgrade backup if reverting to an older application.

Provenance kinds: `user`, `import`, `observation`, `software`, `ai`, `summary`, `derived`. Optional fields include `source_id`, `source_location`, `confidence`, `extraction_method`, `model`, `parent_event`, and `evidence`. Accepting a proposal preserves its origin and records user review separately.

## Optimistic editing

The Notes, Projects and Inbox filters query the service before pagination. `/memories`
accepts `type`, `project`, `status`, `memory_class`, and exact `tag` (combined with AND).
Its optional `q` is a literal title substring, including for archived memories. `/search`
also accepts separate `type`, `project`, `status`, `class`, and `tag` parameters alongside
its existing query syntax; explicit parameters take precedence over query text.

`GET /connection-options?q=...&exclude=UUID&offset=0` searches eligible entities across
the brain by name or project, returning at most 20 lightweight options. It uses the
same endpoint eligibility as relationship creation, excludes the source and archived
objects, and includes private memories for authenticated local manual selection.

`GET /timeline?timezone=Europe/Brussels&limit=80&offset=0` returns the latest event
plus `day` and `count` for each memory/calendar-day group. Non-memory events remain
individual entries. Grouping happens before pagination. Optional `before` and `after`
are inclusive UTC timestamps. Add `aggregate=MEMORY_UUID&day=YYYY-MM-DD` to page
through that group's original events in newest-first order. This is a read-only view
over the event log; `/events` remains unchanged.

Archive restoration uses the normal version-checked memory PUT with `status: active`.
It appends a revision, retains provenance and earlier revisions, and leaves previously
ended relationships ended. The Archived tab searches titles and metadata because
archived content intentionally has no full-text index entries.

Read a memory, remove output-only fields (`id`, `path`, `content_hash`, `created_at`, `updated_at`, `version`), and PUT the remaining input with `expected_version` set to the version you read. A stale version or externally changed Markdown returns 409. Keep the user's draft, reload, and reconcile explicitly; never silently retry by overwriting a newer revision.

## Limits and network behavior

Memory proposals create a new memory by default. To propose an update, put the existing `memory_id`, its `expected_version`, and the changed fields in `payload`. Acceptance checks that revision and preserves the original proposal provenance. Stale updates stay pending for explicit review. Example:

```json
{
  "kind": "memory",
  "payload": { "memory_id": "EXISTING_UUID", "expected_version": 2, "body": "Phase 3" },
  "evidence": ["SOURCE_UUID"],
  "provenance": { "kind": "ai", "actor": "local-model", "model": "my-model", "evidence": ["SOURCE_UUID"] }
}
```

Text memory: 2,000,000 characters. Text extraction: 2 MB bytes. File import: 100 MiB. Query: 2,000 characters. Pending/running jobs: 1,000. Visible graph: 800 maximum per API response (UI requests 350). Context budget: 300–32,000 conservative estimated tokens. Provider responses are bounded to 8 MiB and 60 seconds. Redirects are rejected. UI source images/embedded media never fetch external URLs.

The API is a trusted-owner boundary: a valid session may read or write the brain and select local backup/restore destinations. It is not intended for untrusted multi-user clients. AI models do not receive this session key or tools.
