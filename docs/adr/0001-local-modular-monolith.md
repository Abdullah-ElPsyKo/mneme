# ADR 0001: Node 24, SQLite, React, browser presentation shell

Status: accepted.

The initial environment has Node 24 with built-in SQLite/FTS5, and no Rust toolchain. Use TypeScript across domain/API/UI, built-in SQLite, and a lightweight loopback service. React is a view layer, not the owner of memory. A browser app window avoids shipping a second Chromium runtime. This trades native tray/global shortcuts and signed packaging for a smaller, directly runnable system. Tauri remains a possible future shell around the same local API. All dependencies and assets are installed locally; production operation needs no CDN.
