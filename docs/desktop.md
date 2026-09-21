# Mneme desktop

## Windows user workflow

Install `Mneme_0.3.0_x64-setup.exe` and launch Mneme from Start. The x64 per-user installation includes `Mneme.exe`, a pinned Node runtime named `mneme-core.exe`, compiled core/UI resources, production dependencies, and the Node license. No Node/npm installation is required. A missing WebView2 runtime is installed using Microsoft's official embedded bootstrapper; that bootstrapper downloads the runtime. Existing WebView2 installations work offline.

Choose the recommended `%LOCALAPPDATA%\MnemeBrains\Default`, another empty directory, or a folder containing `database/brain.db`. Selection never moves, imports, or deletes a brain. The current engine opens its existing Markdown, SQLite, originals, indexes and configuration directly. An unavailable drive or a brain owned by another process produces an error and a choice to reopen or select a different brain.

Installation defaults to `%LOCALAPPDATA%\Mneme`. Disposable WebView/desktop state lives under `%LOCALAPPDATA%\app.mneme.desktop`; the window-state plugin uses the application configuration directory. Brain folders are deliberately outside both locations. The native picker rejects installation/settings directories. Uninstall removes the program, its shortcuts and its Windows Run entry. The standard uninstaller's optional app-data checkbox clears WebView/preferences, not the recommended brain. Reinstall and use Open existing brain if preferences were cleared.

## Native lifecycle

- Native Windows title bar, 1280×850 initial logical content size, 900×620 minimum, minimize/maximize/restore, saved size/position/maximized/fullscreen state. F11 toggles fullscreen. Hidden visibility is not persisted as a surprise on a normal launch.
- Closing: Ask (default), Exit or Keep in tray. Unsaved note/capture drafts block silent exit; hiding preserves them for the current session. In-app discard behavior stays unchanged.
- Tray: Open Mneme, Quick Capture, Pause Background Processing, Status, Exit. A second launch brings forward the existing instance.
- Global capture: Ctrl+Alt+Space by default, configurable or disabled in Settings → Desktop. Conflicts produce an error without silently replacing another program's shortcut. A separate 500×350 native window reuses the original capture component/API. Closing it hides and retains the draft; saving resets it. The existing focused-window shortcut remains Ctrl+Shift+Space.
- Optional Windows autostart uses a per-user Run entry and `--tray`. No service, privileged task, scheduled job, or periodic polling is installed.
- Hidden main windows disconnect live-update SSE and stop graph animation frames and CSS animations while retaining React/editor state. Reopening reconnects and refreshes. If hidden processing is disabled, running bounded work finishes, and queued work/reconciliation stays suspended until reopening. This ephemeral suspension does not overwrite canonical brain preferences. Tray pause changes the existing brain background setting.
- Orderly exit requests core shutdown, aborts/drains active API requests, finishes bounded background work and closes SQLite. A 70-second fallback and a Windows kill-on-close job object prevent a stuck/orphaned core; existing WAL/outbox recovery handles an unclean stop. Closing the inherited stdin pipe is an independent shutdown signal.

## Transport and security

[ADR 0004](adr/0004-tauri-desktop-and-bundled-core.md) explains why this conversion preserves the existing Node core and HTTP semantics. The native WebView uses an authenticated random loopback origin; no address bar, session URL or console appears in the normal workflow. The optional browser/CLI service remains a separate developer/integration entry point.

The session secret travels only over inherited stdout and the initial WebView URL fragment, which the React authentication flow clears after exchanging it for an HttpOnly SameSite cookie. Secrets are not passed in process arguments, persisted or logged. Node options/module injection environment variables are removed from the child launch. Only fixed bundled executable and entry paths can be started; Windows paths are normalized before crossing into Node.

Runtime Tauri capabilities name the exact current child origin and window. Capture receives fewer commands than main. Every application IPC command also verifies the calling window and its actual origin. The bundled setup page receives only setup/close/state commands. No frontend filesystem, SQL, shell, process-spawn, generic window or arbitrary plugin permissions are granted. Native dialog, global-shortcut, autostart and opener plugins are called from Rust behind application commands. New WebView windows are denied and navigation is restricted to trusted bundled/current-core origins. Explicit reference clicks can open validated HTTP(S) URLs in the user's browser.

Existing Host/Origin/fetch metadata/authentication/schema checks and Markdown sanitization remain unchanged. Only desktop responses add the exact Tauri IPC transport to CSP `connect-src`. Production inline scripts, arbitrary external connections and framing remain blocked.

## Build from source

Windows x64 prerequisites: Node 24.14+, MSVC C++ build tools/Windows SDK, Rust stable MSVC, WebView2. These are build-machine requirements, not end-user Node requirements.

```powershell
npm ci
npm run desktop:runtime
npm run desktop:build
```

The runtime script downloads Node 24.18.0 from nodejs.org, verifies a reviewed SHA-256 pin, and obtains its license from the matching official tag. `desktop:prepare` verifies the runtime again, builds existing TypeScript/React assets, installs only locked backend dependencies with lifecycle scripts disabled, and stages resources. `desktop.mjs` uses system Rust or the optional workspace-local `.toolchains/cargo` and `.toolchains/rustup` installed during this conversion. It normalizes Windows PATH casing without modifying the user's permanent PATH.

Installer output: `src-tauri/target/release/bundle/nsis/Mneme_0.3.0_x64-setup.exe`. The complete application directory is `src-tauri/target/release` (the main executable alone needs its companion runtime/resources). Application icons are generated from the existing `ui/public/mark.svg` using the Tauri icon tool.

```powershell
npm run check
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --release
npm run desktop:dev
```

The Rust launcher test starts the actual bundled core from Windows canonical paths, controls hidden suspension, gracefully shuts it down and checks lock release. Node desktop tests remove Node/npm from PATH, open an existing brain, verify authentication/CSP, capture, suspended queues and parent-pipe shutdown. Native acceptance/performance results are recorded separately in [desktop verification](desktop-verification.md).

## Local Ollama generation

Select Ollama at `http://127.0.0.1:11434`, chat model `qwen3.5:9b`, and embedding model `qwen3-embedding:0.6b`. The chat adapter explicitly sends top-level `think: false` with `/api/chat`, as documented by [Ollama's thinking API](https://docs.ollama.com/capabilities/thinking). Embeddings use only `embedding_model` with `/api/embed`. No provider configuration or privacy preference is silently changed in an existing brain.

Local requests have a bounded 120-second window for model loading/prompt processing to produce response data. After data starts arriving, a 60-second inactivity deadline resets on each received chunk. An active stream has no total elapsed-time limit; cancellation, size limits, authentication, local-only checks and external-consent requirements remain in effect. Connection failures, startup silence and a stalled stream have distinct error messages. The startup deadline cannot distinguish cold loading from a stalled model before the model emits data; exceptionally slow prefill may still require less context or a retry.

Run `node --import tsx scripts/verify-local-ai.ts` for the opt-in real local model check. It uses synthetic evidence in a temporary brain, exercises the authenticated Ask streaming API, checks actual response chunks for disabled thinking, measures first/warm generation, and verifies the embedding model separately. It does not send personal brain contents.

## Signing and future updates

The current artifacts are unsigned local builds. Never disable Windows protections to distribute them. Public releases should Authenticode-sign the application, sidecar (retain Node's publisher signature), and installer/uninstaller with a protected organizational certificate and a trusted timestamp. Verify signatures and hashes after bundling and test installation on a clean Windows VM without Node.

No updater plugin or remote update feed is enabled. A future Tauri updater must verify signed artifacts using a pinned public key; keep the private update key in a protected release-signing environment separate from the repository. Serve a versioned HTTPS feed, protect rollback/version policy, stage releases, and test schema compatibility and backup recovery. Updating replaces application files, never canonical brain folders. Manual upgrades can use the same NSIS installer in the meantime.
