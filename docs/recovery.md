# Recovery runbook

## Normal backup

1. Save edits and resolve reported external-file errors.
2. Create a snapshot in Settings → Backups. Set a 12+ character passphrase when encryption is needed.
3. Verify the snapshot. Mneme also verifies automatically at creation.
4. Copy snapshots to another device using your own file tools.
5. Periodically restore into a new directory and run Doctor with deep checking.

Retention only removes application-recorded older snapshots in the configured destination. Passphrases are not retained in settings or logs. Scheduled backups are opt-in and unencrypted; encrypted scheduled/remote backup is not shipped.

## After an interrupted write

Restart using the same brain directory. A committed outbox entry is replayed using an atomic file replacement. If the disk file differs from both the pre-write and intended content, its bytes are preserved in the object store and a `recovery.external_conflict` event references the source. Look in Timeline/Sources and compare before making further edits.

If space is exhausted, free space outside the vault and restart. Do not manually delete `database/brain.db`, its WAL file, or the outbox. The UI may report a failed save even when a revision committed before a disk error; inspect history before submitting again.

## External edit conflicts

A stale editor cannot overwrite a changed file. Run Reconcile files in Settings → Processing, or `brain reconcile` with the service stopped. Invalid frontmatter is reported and the original imported bytes remain available. A filesystem deletion archives the last committed version and rematerializes it, preserving knowledge instead of treating deletion as permanent erasure.

## Index failure

Canonical information lives outside `indexes/`. Run Rebuild index. If the index database itself cannot be opened, stop the service, move the entire `indexes` directory aside using your own file tools, then restart and rebuild. Do not remove `database/`, `vault/`, or `objects/` to fix a search problem. Embeddings are derived and must be regenerated with the original provider configuration.

## Restore

Use Settings → Backups → Restore, or:

```powershell
npm run brain -- verify "D:\Backups\snapshot.zip"
npm run brain -- restore "D:\Backups\snapshot.zip" --to "C:\Brains\Restored"
npm run brain -- doctor --deep --brain "C:\Brains\Restored"
npm start -- --brain "C:\Brains\Restored" --open
```

The destination must not exist. The archive is verified before extraction, extracted to a unique sibling staging directory, checked with SQLite integrity and foreign key checks, then renamed into place. Restore clears pending file writes because the snapshot's Markdown was already reconstructed from its committed revisions. Provider credentials are not backed up. AI and external access are disabled in restored settings.

## Stale owner lock

`database/owner.lock` records the owning PID and a random nonce. Normal shutdown removes it. On restart, a lock whose process is gone is reclaimed automatically. If a PID was reused or the lock is unreadable, Mneme fails closed. Check that no Mneme process owns the brain before removing that lock manually. Never remove a live owner's lock.

## If the app is unavailable

Read `vault/*.md` using any text editor. Original imports are under `objects/<prefix>/<SHA-256>`; `sources` in SQLite maps hashes to original names. SQLite tables and `events.payload` contain structured records and full Markdown revision snapshots. All data uses UTF-8/JSON/SQLite/ZIP, without a proprietary format. Keep canonical directories together when moving a brain.
