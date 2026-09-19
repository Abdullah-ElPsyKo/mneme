# Initial release boundaries

Mneme ships working local storage, revision history, provenance, original-file preservation, search, context compilation, graph, task/record services, proposals, optional models, queue, GUI/API/CLI and tested backup/restore. This document separates those capabilities from the larger product vision.

## Current limits

- **Desktop distribution:** Tauri 2 Windows x64 executable and NSIS installer, bundled Node 24.18.0, native tray, autostart, window state and global capture are implemented. The installer is unsigned; there is no automatic updater. Windows on ARM and other operating systems are not packaged. See [desktop verification](desktop-verification.md) for actual acceptance results and remaining checks.
- **Platform:** Windows and WebView2 are the desktop target. Browser development still requires Node. macOS/Linux backend branches have not received equivalent installation, watcher or credential testing. Non-Windows credentials use the process environment.
- **Consolidation:** incremental explicit wiki-link proposals, explicit fact-key conflict reporting and orphan detection. General semantic deduplication/merging, automatic project narratives and AI classification are future work. Originals and prior revisions are never summarized away. Memory proposals support both creation and optimistic updates; user review is required except for explicitly enabled wiki-link auto-acceptance.
- **Import:** all accepted files retain exact original bytes. UTF-8 text and Markdown can be extracted up to 2 MB. PDFs, images, office documents, audio and video are preserved with an honest extraction-unavailable note. OCR, transcription and specialized parsers are not bundled.
- **Retrieval:** FTS/entity/graph fusion is bounded to 1,500 candidates; narrow a broad query with filters. Embeddings use a bounded linear cosine scan (up to 20,000 matching vectors), not an ANN index. No learned reranker. The initial embedding batch covers 100 recent memories; individual memory jobs are available.
- **Time:** memory revision history and historical graph views work. Search uses the current full-text index; exhaustive historical full-text search is not implemented. Temporal conflicts require explicit fact keys/values and supersession metadata; arbitrary prose contradictions cannot be determined reliably.
- **Ask:** questions, answers and selected revisions persist locally. Each question gets independently retrieved context; prior chat turns are not automatically added to the model prompt. Name the topic in follow-up questions. Older turns are available through the paginated API; the UI opens the latest 30. Citation validation cannot verify factual correctness.
- **Models:** Ollama and OpenAI-compatible adapters are implemented. Other vendors require a compatible endpoint or a new adapter. Local protocol fixtures test generation, streaming, embedding and outages. Real Qwen2.5 0.5B inference was also exercised, but this tiny model gave inconsistent factual answers and omitted citations. Its download is a test asset, not a quality recommendation. AI remains off by default.
- **Graph:** 350 entities per UI view, 800 maximum at the domain/API boundary. Type clusters, focus, pagination, label culling, selection, historical and retrieved states work. Clusters are derived from entity types rather than semantic topic discovery. No endless ambient animation or fabricated edges. No million-node WebGL renderer.
- **Lists:** bounded pagination/load-more keeps the initial view small. Some lists may grow after repeated load-more operations; there is no generalized windowing engine for every table.
- **Data protection:** the active brain is plaintext, backups optionally encrypted. No cloud backup transport, sync, audit signing, password recovery or direct SQLCipher integration. A restore targets a new directory.
- **Scale:** 1,000 and 10,000 canonical memories measured; 100,000 supported by the benchmark script but not exercised. Post-work process memory reached roughly 633 MiB in the 10,000-memory benchmark. Large imports are bounded but currently materialize request bytes in memory.
- **Long-term operations:** tested recovery cases and deterministic migrations are useful evidence, not years of field experience. Physical power-loss testing, long-duration soak testing and third-party audit remain separate validation work.
- **Integrations:** no distributed sync, financial/fitness service adapters, browser extension, mobile client, automatic Git commits or arbitrary executable plugins. Stable IDs, standard files and the authenticated local API provide extension points.

## Next engineering priorities

1. Independent security review, crash/lock fault injection and long-running soak tests across supported operating systems.
2. Streaming large-file ingestion and bounded-memory index rebuilds; 100,000-memory measurement.
3. Rich document extraction in isolated workers and explicit capability reporting.
4. Reviewable project-summary consolidation and tested higher-quality local models.
5. Native packaging, global capture and OS-managed startup.
6. Historical full-text indexing and scalable vector storage once measured workloads justify them.
