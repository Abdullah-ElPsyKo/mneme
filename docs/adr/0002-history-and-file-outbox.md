# ADR 0002: Transactional history and Markdown write outbox

Status: accepted.

SQLite and the filesystem do not share a transaction. Record immutable revisions and a pending file write atomically in SQLite, then flush and atomically replace the Markdown file. A pending write is replayable and idempotent. Preserve externally edited bytes as evidence before reconciliation, including an interrupted write conflict. An external deletion archives the memory with an event rather than deleting history. Derived indexes may lag and are always recoverable. Recovery evidence in events does not change the human-readable canonical format.
