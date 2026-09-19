# Delivery and follow-on work

## Implementation order

1. Storage, schema migrations, append-only events, atomic Markdown materialization and recovery.
2. Ingestion, immutable evidence, graph and tasks, typed provenance and proposal review.
3. Rebuildable FTS5, hybrid ranking, temporal queries and bounded context compilation.
4. Optional OpenAI-compatible/Ollama providers, embeddings, guarded cloud access.
5. Durable jobs, file watcher, settings, diagnostics, API and CLI.
6. Consistent snapshots, encrypted backup, validation, restore into a new brain.
7. Graph-led desktop interface, keyboard capture/search, complete management views.
8. Integration/E2E tests, crash and security review, measured performance, visual review and installation documentation.

## Explicit future boundaries

Native signed installers, cross-device sync, mobile/browser extensions, arbitrary plugin execution, automatic financial/fitness integrations, OCR, and general-purpose agent actions are separate releases. Canonical data and local APIs permit these without making them required infrastructure. Rich document extraction is capability-based; every file remains preservable even when extraction is unavailable. No UI may claim an unsupported extraction or model capability.

This document records intended scope. See verification and limitations documents for what was actually exercised.
