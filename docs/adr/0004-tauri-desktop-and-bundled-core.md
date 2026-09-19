# ADR 0004: Tauri 2 shell with a supervised, bundled Node core

Status: accepted for the desktop conversion.

## Decision

Preserve the existing React views, canonical storage, domain services and authenticated loopback API. Tauri 2 supplies the Windows application window, lifecycle, tray, native directory selection, global capture and installer. The installer includes a pinned Node runtime and production backend dependencies. No Node installation, terminal or browser is required by an end user.

The WebView loads the existing UI from a random loopback port owned by the bundled core. Its session secret travels through a private parent/child pipe and the WebView's initial fragment exchange. The native window does not show an address bar. The port and secret are not persisted. Existing Host/Origin checks, authentication and HTML sanitization remain in force.

Replacing the mature HTTP request/streaming boundary with a new IPC transport would duplicate API semantics and risk storage/retrieval regressions. The explicit allowance in the desktop brief makes the supervised loopback approach the safer first conversion. A future IPC transport can implement the same application commands without changing canonical data.

## Native boundary

Only narrowly scoped desktop commands are exposed. File/directory selection occurs in native dialogs; the frontend cannot request arbitrary filesystem reads, SQL or shell execution. Native commands check both the calling window and its actual trusted URL. Runtime capabilities are restricted to the specific child-service origin. External navigation cannot inherit native privileges.

The native parent launches one fixed bundled executable with one fixed bundled entry point. Arguments and environment are constructed internally. A Windows job object and stdin ownership prevent orphaned backend processes; orderly shutdown drains active requests and jobs. The parent surfaces startup/crash errors rather than reopening a browser or silently switching to another brain.

## Data and updates

The recommended brain is `%LOCALAPPDATA%\MnemeBrains\Default`, outside both the installation and disposable application settings directory. The user can choose a new directory or open an existing compatible brain. Selection never moves/deletes a brain. Desktop preferences and window state are separate from canonical brain configuration. Updating or uninstalling the application must retain user data.

The Windows bundle uses the system WebView2 runtime and the Tauri NSIS installer, including Start Menu/uninstall metadata. No unsigned automatic updater is enabled. A public update channel requires Authenticode signing, signed update artifacts, protected signing keys and explicit release verification.

## Alternatives considered

- Rewriting the engine in Rust: unnecessary migration risk to a working storage/recovery layer.
- Node single-executable packaging: possible later, but bundling dynamic worker entry points and dependencies into a SEA adds avoidable complexity now. A pinned runtime plus ordinary files is inspectable and reproducible.
- Electron: duplicates the browser runtime and changes the requested shell technology.
- Static WebView plus a new Rust-to-Node IPC proxy for every API call: broader changes to streaming, authentication and tests with little immediate product benefit.

References: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [capabilities](https://v2.tauri.app/security/capabilities/), [Windows installers](https://v2.tauri.app/distribute/windows-installer/).
