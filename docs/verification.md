# Verification record

Windows verification, 2026-09-16. Runtime: Node 24.18.0, native SQLite 3.53.1, Microsoft Edge 153.0.4234.32. Host reports AMD Ryzen 7 9800X3D, 8 logical CPUs available to this environment, approximately 31.1 GiB RAM. Measurements are local samples, not portable performance guarantees.

## Functional checks

- Production server/UI type-check and Vite build pass. All browser assets are local.
- All **35 unit/integration tests pass**, covering persisted revisions and migrations, append-only history, optimistic edits, simulated disk-write failure and replay, external edits/deletions, originals/deduplication, parsing, typed graph/tasks/records, proposal review and updates, consolidation, hybrid retrieval, context budgets, privacy, provider protocols/outages, jobs, DPAPI, API attacks, shutdown, snapshots and real restore.
- Eight end-to-end workflows pass against the built application in Edge. They exercise onboarding, Markdown editing/preview, capture, deterministic search, keyboard palette, provenance/history, graph links, tasks, original downloads, offline Ask, restored Ask history, backup verification/restore, a production worker, restart/session invalidation and 390×844 responsive layout.
- A separate clean directory successfully ran `npm ci --offline` from the local package cache, production build and a smoke test of HTTP assets, authenticated API, durable memory/search, a production rebuild worker and Doctor. This verifies a fresh dependency tree; it is not an offline first-install distribution.
- Production dependency audit reported zero known vulnerabilities. The lockfile is included in the source deliverable; repeat the audit over time.

Reproduce with `npm run build`, `npm test`, `npm run test:e2e`, and `powershell -File scripts/check-install.ps1`. Isolated brains live under `.test-brains` and are cleaned with checked directory boundaries. Personal `.brain` is never used by tests.

## Performance

`npm run bench -- 1000` and `npm run bench -- 10000` create actual Markdown files and canonical events, exercise retrieval, rebuild and verified snapshots, reopen storage and sample five idle seconds. Search uses 12 samples per query; the reported p95 is the highest sample. Test documents are approximately 1 KB of infrastructure notes, with 30 projects.

| Operation                           |   1,000 memories |  10,000 memories |
| ----------------------------------- | ---------------: | ---------------: |
| Create/index all memories           |          11.78 s |         153.07 s |
| Exact identifier, median / p95      |   0.69 / 2.23 ms |  9.01 / 10.19 ms |
| Project/type-filtered, median / p95 |   0.90 / 1.45 ms | 19.67 / 21.81 ms |
| Broad lexical, median / p95         | 10.67 / 12.00 ms | 45.85 / 48.15 ms |
| Graph query, 350-node cap           |          3.45 ms |         35.62 ms |
| Full index rebuild                  |           0.87 s |           8.37 s |
| Snapshot + verification             |           1.64 s |          14.06 s |
| Reopen + reconciliation             |           0.82 s |           4.81 s |
| Idle CPU over 5 seconds             |    0 ms measured |    0 ms measured |
| Process RSS after workload          |          326 MiB |          633 MiB |
| Final integrity checks              |             Pass |             Pass |

The 1,000-memory run preceded the startup file-stat cache. The 10,000-memory run includes it. RSS is the same benchmark process after creation, rebuild and backup; it includes V8 heap retained after work, and is not a clean-process idle baseline. No forced garbage collection was used. A five-second idle sample does not establish long-term zero CPU use. The script accepts 100,000 but that scale was not run.

The review replaced per-candidate Markdown parsing with batched hydration from matching index revisions and moved filters before the candidate cap. This reduced a measured 1,000-memory broad query from about 701 ms to 11 ms. The disposable file-stat cache reduced measured 10,000-memory reopen time from about 7.6 to 4.5–4.8 seconds.

### Graph and large files

`npx tsx scripts/profile-ui.ts` exercises 350 entities and 349 real test relationships in a 1440×960 headless Edge view while panning. There were 121 measured redraws: median 0.5 ms, p95 0.9 ms. A 180-frame sample had median 4.2 ms and p95 4.3 ms between animation callbacks, with no interval above 33.4 ms. Headless scheduling and this display environment are not evidence of a universal refresh-rate guarantee. The redraw measurement runs through the synchronous task's microtask checkpoint.

`npx tsx scripts/profile-import.ts` imports synthetic binary files through the real base64 API and checks original hashes:

| File   | API duration | Preserved bytes | Process RSS after request |
| ------ | -----------: | --------------: | ------------------------: |
| 5 MiB  |       102 ms |       5,242,880 |                   134 MiB |
| 50 MiB |       390 ms |      52,428,800 |                   609 MiB |

These are sequential imports in one process. Memory includes payload copies and the in-process test client. Large-file streaming remains a priority; current bounds prevent unlimited requests but do not eliminate temporary allocation or synchronous hashing.

Raw machine-readable results are generated under `artifacts/benchmark-*.json`, `graph-performance.json`, `import-performance.json`, and `fresh-install.json`. Artifacts are ignored by Git so local data and session tokens cannot be committed accidentally.

## AI verification

Local fixture servers test Ollama NDJSON and OpenAI-compatible SSE generation, embeddings, redirects, malformed/unavailable service behavior and fallback. These fixture tests do not measure model intelligence.

The existing Ollama service initially had no model weights. A public [Qwen2.5 0.5B model](https://ollama.com/library/qwen2.5:0.5b), approximately 398 MB, was downloaded for a separate real-inference check. `scripts/check-local-model.ts` sends only synthetic test evidence to loopback. Both adapters returned generated responses and preserved the selected source revision and answer. The final sample took approximately 456 ms through Ollama and 104 ms through its compatibility API, with the model already loaded.

The tiny model's answer quality was inconsistent: one sample identified MGMT01 correctly, another did not, and both omitted citations. An earlier sample also answered incorrectly. These are recorded failures of model quality, not hidden behind a successful transport check. Missing/unknown citations now produce a warning in the application. Citation validation cannot prove that a statement is supported. The application remains useful in evidence mode and starts with AI disabled. Real embedding weights and large model quality evaluations were not exercised.

## Visual and security review

All major screens were inspected, including populated graph, evidence/history and mobile capture. See [design system](design-system.md) for the two-pass review and [security review](security-review.md) for controls, fixed findings and residual risks.

No physical power failure, independent penetration test, month-long soak, 100,000-memory load, other-OS fresh installation or packaged-native update cycle was tested. See [release boundaries](limitations.md) before treating this initial release as a field-proven archival system.
