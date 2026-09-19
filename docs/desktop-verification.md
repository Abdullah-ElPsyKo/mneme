# Desktop conversion verification — 0.2.0

Updated 2026-09-17. Final stabilization used targeted testing, as requested; previously passing suites were not exhaustively repeated.

## Brain-opening defect and data preservation

The first installed build reproduced an EISDIR/lstat error at the drive root while starting the bundled core. Tauri supplied an extended Windows resource path; joining a string containing forward slashes produced an invalid Node entry path. This was a launcher defect, before any storage migration.

The launcher now normalizes resource/root paths with `dunce` and joins entry-path components individually. Native diagnostics distinguish early child exit from startup timeout. The real Rust launcher regression exercises canonical Windows paths containing spaces. Brain directory boundaries also compare resolved Windows components case-insensitively.

Verified: native recommended-brain creation/onboarding; native folder picker selecting an existing compatible brain; installed replacement reopening that saved brain with 18 memories and 20 connections. All 19 existing canonical Markdown/original-object files retained identical SHA-256 hashes across reopening. Clean native exit worked. The actual installed uninstaller completed successfully and retained the database and all 19 canonical files. No user brain was moved, reset, replaced or migrated to a new format.

## Targeted automated checks

- TypeScript/React production build: pass.
- Five Rust tests: pass (settings validation/atomic replacement, exact origin boundary, Windows directory boundary, real bundled launch/control/shutdown).
- Seven model/job tests: pass, including explicit Ollama `think: false`, separate chat/embedding model routing, stream progress beyond the startup deadline, startup silence, stalled streams, user cancellation, local-only/redirect restrictions and DPAPI.
- Two API tests: pass, including interrupted answer persistence during shutdown, authentication and mutation/restart persistence.
- Two packaged-core tests: pass; no Node/npm on PATH, existing brain/history retention, private API/CSP, hidden queue suspension, graceful shutdown and pipe-EOF lock release.
- Earlier baseline: all 37 backend/integration tests and all 8 browser E2E tests passed. Those browser workflows include editing/revisions, graph, import/download, evidence-only Ask, backup/verify/restore/Doctor and restart. The full suites were not rerun after the narrow model deadline change.

## Real local Ollama acceptance

`scripts/verify-local-ai.ts` exercised the authenticated `/api/ask/stream` route against the running local Ollama with synthetic evidence and the user's specified model pair. Local Only stayed enabled.

| Check                | Result                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| First qwen3.5:9b Ask | First content 7.208 s; completed 46.452 s; 410 output tokens                          |
| Warm qwen3.5:9b Ask  | First content 0.148 s; completed 26.422 s; 277 output tokens                          |
| Thinking             | Both requests sent `think: false`; both real responses contained zero thinking chunks |
| Timeout/citations    | Both completed, cited evidence, and returned no warning/timeout                       |
| qwen3-embedding:0.6b | Separate embedding operation; 1,024 dimensions in 1.145 s                             |

The previous fixed 60-second lifetime is removed. Local startup/prefill remains bounded at 120 seconds; subsequent response inactivity is bounded at 60 seconds, resetting when bytes arrive. A progressing response has no total elapsed deadline. A scaled deterministic fixture verified generation lasting longer than the configured startup limit. These measurements do not promise identical latency for larger brains/prompts or other hardware.

## Native UI observations

The existing React appearance, native title bar, graph and inspector, projects, notes, search and timeline rendered correctly. A global Ctrl+Alt+Space opened the separate capture window; Ctrl+Enter saved a capture, which appeared in main-window search/timeline. A capture autofocus issue was corrected without changing the layout. Native close confirmation and existing-brain picker worked. Test data stays isolated in `.test-brains/desktop-acceptance`.

The final installer was installed successfully after the uninstall check. Its bundled AI adapter matches the tested compiled file. Launching the installed Start Menu shortcut restored the saved brain and graph. Keep in tray hid the main window; Ctrl+Alt+Space from Notepad opened only the separate capture window with its textarea focused. No Notepad content was changed.

Initial visible-idle profile (15.020 s, native process plus core and WebView descendants): 3.122% of one logical CPU, 667.24 MiB summed working sets, 372.72 MiB private memory. Working-set totals can double-count shared pages; a capture WebView was retained. This is a development-host sample, not a clean-machine benchmark.

Final installed hidden/tray profile, before creating a capture window: 0 ms measured CPU across the native/core/WebView process tree over 15.023 s (0.000% of one logical CPU), 553.81 MiB summed working sets and 300.60 MiB private memory. Main-window absence was verified before measurement. This sample establishes idle suspension, not a universal zero-CPU guarantee.

## Important verification limits

Artifacts are unsigned. A clean Windows VM without Node, actual Windows scaling at 100/125/150/200%, full native cold/warm startup and graph performance benchmarks, autostart at Windows login, and exhaustive native tray-menu/window-state combinations have not been certified. Native file drag/drop and backup/restore were not repeated manually; existing browser E2E and backend storage tests cover those unchanged workflows. The bundled-runtime test removes Node/npm from PATH, but does not replace clean-machine installer qualification.

These limits are documented rather than represented as passing checks. No known critical startup or data-loss defect remains from the tested paths.
