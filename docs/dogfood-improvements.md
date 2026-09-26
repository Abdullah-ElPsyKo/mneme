# Graph, typography and grounded structured Ask

## Implemented scope

- `ui/Graph.tsx`: existing canvas/layout retained; restrained orbital guides, type-colored edges, direction arrows on focused/zoomed links, legible labels with dark outlines, viewport label budget, memory/entity shapes, graph key, and persistent Names toggle. No idle animation loop. Hidden-window and reduced-motion behavior retained.
- `ui/App.tsx`, `ui/lib.tsx`: entity type suggestions use a native searchable datalist; custom strings remain allowed. Specific-name versus kind guidance is shown. Common entity types have stable node colors.
- `ui/tokens.css`, `ui/styles.css`, `ui/Settings.tsx`, `server/security/settings.ts`: shared text tokens replace individually fixed pixel sizes, with a 12px supporting-text floor at Default. Compact/Default/Large scale text only. Preferences are local to the brain; existing settings receive defaults.
- `server/retrieval/structured.ts`, `server/retrieval/evidence.ts`, `server/app.ts`: deterministic source selection adds task evidence to memory retrieval.
- `server/context/compiler.ts`, `server/context/style.ts`, `server/memory/conversations.ts`, `ui/Ask.tsx`: budgeted task snapshots retain real task IDs, versions and provenance in saved answers and audit events. Task sources expand in place; memory sources still open the inspector.

## Ask source selection

Normal questions such as “What is FORGELINE?” retain lexical/entity/graph and optional semantic memory retrieval. Projects are already memories with `type=project`; project overview questions use authoritative `project_state`. Goals are goal memories, not a separate goal table. Tasks are not automatically reinterpreted as goals.

Explicit task questions additionally query the Tasks table. Without a requested status they select unfinished `open`/`doing` tasks; explicit statuses or “all” can include done/cancelled tasks. Residual question words scope task title/project; `project:` and task `status:`/`type:` filters are respected. Unsupported memory-only operators do not broaden task selection. Conversational fillers in the supplied example are ignored for intent selection.

At most 20 matching task candidates enter the existing context token budget, ordered by in-progress/open state and due date. No model call occurs when the combined selected evidence is empty. The prompt instructs the model to treat the result as selective, not an exhaustive inventory. No mutation tools were added.

Archived tasks are excluded. A task's associated memory must be public, current, unarchived and not superseded. Known memory references in task provenance receive the same exclusions. Tasks have no independent privacy field. Existing provider consent and local-only rules remain unchanged. Saved answers retain snapshots, as they already did for memory evidence; they are not live task views. Permanent erasure follows the existing dependency scan, including task and memory IDs in snapshots.

## Existing entity and relationship model

An entity is a UUID, name, open-ended type, optional memory reference, properties, timestamps and provenance. Each memory has a corresponding entity with the same UUID. A standalone entity has no memory reference. Type identifiers are lowercase, start with a letter, allow digits/underscores/hyphens, and have a 40-character maximum. Suggestions do not create an enum or alter existing custom types.

All three connection combinations use the same relationship table:

| Connection      | Representation                                                      |
| --------------- | ------------------------------------------------------------------- |
| Memory → memory | Relationship between the memories' entity UUIDs                     |
| Memory → entity | Relationship between a memory-backed entity and a standalone entity |
| Entity → entity | Relationship between standalone entity UUIDs                        |

Relationships store `id`, `from_id`, `to_id`, `type`, JSON provenance, `created_at`, `valid_from`, and nullable `valid_until` in SQLite. Creation/end events preserve audit history. Unlinking ends validity; it does not erase the relationship. Archive rules retire relevant connections while historical views can retain them.

Direction is stored explicitly. The same active directed pair and type is deduplicated; reverse-direction connections are distinct. Self-connections are rejected. There are no type-specific dependency, inheritance, transitivity, symmetry or validation rules.

| Label                                       | Current support                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `related_to`                                | Inspector default; otherwise an ordinary user-defined string                  |
| `depends_on`, `supports`, `part_of`, `uses` | Accepted custom strings; no built-in operational semantics                    |
| `references`                                | Existing consolidation proposal label for detected references                 |
| Other labels                                | Accepted if they match the lowercase identifier format, maximum 60 characters |

The inspector already accepts custom relationship labels. The new graph key lists only labels present in the current view. Familiar labels have stable colors; other labels share a neutral treatment. This is presentation, not a new enforced taxonomy. Dashed lines continue to indicate AI/derived provenance, separately from type colors.

Retrieval uses active graph links as a bounded ranking signal: it traverses neighbors in either direction, preserves actual direction/type in evidence, and still applies memory eligibility and relevance selection. Standalone entities are anchors for finding memories; arbitrary entity properties are not independently compiled into Ask evidence.

## Data and limitations

No database migration, memory rewrite, relationship rewrite or new stored semantic rules. The database remains schema 6. Settings gain two defaulted fields, and saved Ask JSON can now contain task snapshots. This preserves old data when read by the updated app; downgrading to older binaries that reject new settings fields is not promised.

- Task routing is conservative English keyword/lexical matching, not unrestricted natural-language query planning. Relative date expressions and arbitrary structured records are not newly supported.
- Task evidence is capped and budgeted; it does not establish a complete task count.
- Project association remains the existing text label; no new project/task identity mapping is inferred.
- Node names obey collision/viewport limits when enabled. The entity list provides keyboard access and full labels. Dense graphs still benefit from focus, type filters and pagination (350 nodes per UI page; existing API maximum 800).
- Entity suggestions are a native browser datalist, whose presentation is controlled by WebView2/browser.
- No requested item was blocked. Relationship redesign and inferred semantics were intentionally excluded as requested.

## Verification

Disposable brains only. Added `tests/dogfood.test.ts` for source selection, mixed goals/tasks, lifecycle filtering, empty/no-model behavior, source snapshots, context budget, privacy/archive/validity/supersession, preference defaults and custom type preservation. Added `tests/e2e/dogfood.spec.ts` for 8/350-node graphs, names persistence, custom entity creation, task source expansion, all text presets and Large layouts at 1440/800/390px.

Verification results:

- `npm run build`: passed TypeScript server/UI checks and Vite build.
- `npm test`: all 66 tests present at that run passed, including desktop lifecycle tests.
- `npx tsx --test tests/dogfood.test.ts tests/ask-quality.test.ts`: all 10 passed after the final greeting-scope correction, including the additional permanent-erasure case (67 distinct backend cases now exist).
- `npm run test:e2e`: all 19 passed. An initial partial-label selector collision was fixed by making the Entity name lookup exact.
- Targeted Prettier check and `git diff --check`: passed.
- `npm run desktop:build`: produced the native executable and NSIS Windows installer using bundled Node 24.18.0.
- `node scripts/verify-installed-release.mjs src-tauri/target/release 0.3.0`: passed against the packaged build directory (despite the script's historical “Installed” output label). Verified authentication, UI serving, project lifecycle, association/history preservation, Doctor and graceful shutdown without Node on PATH.

Released as **0.3.1** at the user’s request. Version metadata is synchronized in npm, Cargo and Tauri. The installer is `release/Mneme_0.3.1_x64-setup.exe`, alongside its SHA-256 file and release notes. The existing installed copy was updated after the user closed Mneme. Installed executable version, all 1,323 core files, bundled runtime and launch shortcuts were verified. The extended installed-core smoke check passed, including new preferences, custom entity creation, empty task context and persisted task evidence. Direct physical-path verification required execution outside the sandbox because its filesystem policy blocks the packaged-app parent directory. No real brain was opened or changed during verification.

Screenshots are generated under `test-results/`; existing workflow screenshots remain under `artifacts/screenshots/`.
