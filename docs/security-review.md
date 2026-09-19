# Security review

Reviewed 2026-09-16 against the initial implementation and its automated tests. This is an engineering review, not an independent penetration test or certification.

## Trust boundary

Mneme is a single-user local application. The OS user and authenticated local clients are trusted owners. Imported files, Markdown, model output, and websites are untrusted. The application does not protect against malware running as the same OS user, an administrator, or physical access to an unlocked disk.

## Findings and controls

| Area                 | Implemented control and verification                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local API exposure   | Bind only to `127.0.0.1`; random 256-bit session key; timing-safe comparison; ephemeral cookie sessions. Tests reject missing authentication, unexpected Host, cross-origin and cross-site requests. Restart invalidates sessions.                                                                                 |
| Browser injection    | DOMPurify sanitizes rendered Markdown. Embedded images, scripts, objects and SVG are excluded; production CSP blocks inline scripts, external connections and framing. Browser tests render hostile HTML and assert no script/image elements or remote requests. Originals download as attachments with `nosniff`. |
| SQL injection        | All user-supplied values use bound parameters. Dynamic table names are internal constants. FTS input is parsed and escaped separately. Tests include quotes, punctuation, exact identifiers and hostile query text.                                                                                                |
| File traversal       | Managed paths are resolved under the canonical root, reject traversal and symbolic links. Imported filenames do not determine object paths. Restore checks every member, manifest and hash before publishing a new directory. Tests exercise traversal and unlisted archive members.                               |
| Secrets              | Windows DPAPI CurrentUser protects the provider key. The fixed PowerShell script receives input on stdin, never through interpolated commands or arguments. Automated DPAPI round-trip checks confirm the plaintext is absent from the stored blob. Backups omit credentials.                                      |
| Cloud leakage        | Defaults are provider disabled and local-only enabled. Loopback endpoint allowlist, no redirects, HTTPS for external endpoints, explicit per-request consent, no telemetry, remote assets or remote retrieval. Background embeddings are local only. Private memories are excluded from context and embeddings.    |
| Prompt injection     | Evidence is explicitly delimited as data. Models receive no filesystem, shell, API token or action tools. Memory proposals require a separate validated review mutation. Prompts alone cannot guarantee that a model will answer correctly. Missing or unknown citations generate visible warnings.                |
| Canonical corruption | SQLite WAL + FULL synchronous writes + foreign keys. Semantic revision, event and outbox commit together. Atomic flushed Markdown writes follow. Recovery preserves unexpected file bytes. Tests simulate a failed file materialization and restart recovery.                                                      |
| Lost updates         | Memory/task versions are checked optimistically. A second owner is rejected before opening databases. Proposed memory updates require their original expected revision. Conflicts retain the pending proposal or draft.                                                                                            |
| Backup integrity     | SQLite online snapshot; Markdown reconstructed from the same snapshot's revisions; SHA-256 manifest; original-byte checks; verify before retention. Restore into a new directory is tested, including encrypted snapshots, wrong passwords and damaged archives.                                                   |
| Shutdown             | Streaming requests are cancelled and their partial answer recorded before SQLite closes. Outstanding snapshots/handlers and the current worker finish before shutdown. A dedicated test exercises this ordering.                                                                                                   |
| Resource limits      | 100 MiB import, 2 MB text extraction, bounded context/model responses, bounded queue, retry backoff, graph/list limits and 2 MB diagnostic log. Requests and provider calls have timeouts.                                                                                                                         |

## Review changes

### Desktop conversion (2026-09-17)

Tauri capabilities restrict IPC to the current private core origin and named main/capture windows. Each application command also checks the caller's actual URL. No frontend filesystem, shell, process or SQL permissions are granted. The core executable and entry point are fixed bundled paths; session secrets travel through inherited pipes, not command arguments. Windows job ownership and pipe EOF bound child lifetime. Brain selection resolves junctions and compares directory components case-insensitively on Windows, excluding both the installation and disposable settings directory. Canonical data remains outside uninstall targets. See [desktop architecture](desktop.md).

Ollama chat explicitly disables thinking; embeddings retain a separate model/endpoint operation. Provider deadlines now distinguish startup silence and streaming inactivity, retaining cancellation and response-size bounds without killing an actively progressing stream. Local-only validation and explicit cloud consent remain unchanged; targeted privacy, redirect, cancellation and protocol tests pass.

The implementation review tightened same-count stale-index detection, rejection of stale embedding hashes, global supersession filtering, canonical snapshot consistency during concurrent edits, content validation on duplicate imports, external-edit reconciliation, request shutdown ordering, and owner locking before storage initialization. Browser testing found missing accessible names on compact navigation and editor selects; those were corrected. Actual tiny-model inference exposed missing citations, which now produce a visible warning.

## Encryption decision

Active Markdown and SQLite are intentionally portable plaintext. Protect the device with OS account permissions and full-disk encryption. POSIX mode requests are used where supported; Windows files inherit the selected directory's ACL. Mneme does not silently rewrite the user's ACLs.

Optional backup encryption uses zip.js's established WinZip AES-256 implementation. File contents are encrypted and authenticated; filenames remain visible. WinZip's specified PBKDF2 derivation uses 1,000 iterations, so password strength is critical. This is an interoperability tradeoff, not a claim of a modern memory-hard password KDF. Use a long, unique passphrase. See the [WinZip specification](https://www.winzip.com/en/support/aes-encryption/) and [zip.js encryption options](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterAddDataOptions.html).

## Residual risks

- The session key grants full owner access, including selecting backup/restore paths. Do not give it to untrusted integrations. A hostile process running under the same OS account is outside this boundary.
- Loopback HTTP is not transport encryption. Do not expose it through a public proxy. An OS-compromised localhost resolver or model server is outside the application threat model.
- Unencrypted snapshots are the scheduling default; passphrase-protected snapshots are manual. A snapshot on the same physical disk does not protect against disk failure.
- The event log is append-only through application SQL triggers; it is not tamper-proof against an owner modifying the database directly.
- Models may hallucinate even with valid citations. Citation checks establish that a cited source exists in the context, not that it supports the claim.
- Same-size offline edits that deliberately retain timestamps require deep checking or explicit reconciliation; ordinary filesystem notifications force content hashing.
- Large imports use bounded in-memory base64 requests and can briefly block the service while hashing/writing. Archive restore limits are bounded but generous; do not treat this authenticated API as an anonymous upload service.
- No independent fuzzing campaign, malware sandbox, multi-user security boundary, or exhaustive platform certification has been performed.

Dependency audit on the tested lockfile reported zero known vulnerabilities. This is a point-in-time result; re-run `npm audit` and review dependency updates periodically.
