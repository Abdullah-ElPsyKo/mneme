import type { Storage } from '../storage/database.js';
import { Events } from '../events/events.js';
import { now, parse } from '../core/util.js';

// Identifiers here are internal SQL expressions, never request input. Archival
// markers live in the existing append-only event log, not a second storage format.
export function activeObject(kind: string, id: string) {
  return `NOT EXISTS (SELECT 1 FROM events archived WHERE archived.aggregate_id=${id} AND archived.kind='${kind}.archived')`;
}
export function archived(storage: Storage, kind: string, id: string) {
  return !!storage.db
    .prepare('SELECT 1 FROM events WHERE aggregate_id=? AND kind=?')
    .get(id, `${kind}.archived`);
}
export function endRelationship(storage: Storage, relationshipId: string) {
  const row = storage.db.prepare('SELECT * FROM relationships WHERE id=?').get(relationshipId);
  if (!row || row.valid_until) return;
  const at = now();
  storage.db.prepare('UPDATE relationships SET valid_until=? WHERE id=?').run(at, relationshipId);
  new Events(storage).append(
    'relationship.ended',
    relationshipId,
    { relationship: { ...row, valid_until: at, provenance: parse(row.provenance) } },
    { kind: 'user', actor: 'user', evidence: [] },
  );
}
// Called inside the same canonical transaction as the archived object/revision.
export function retireReferences(storage: Storage, objectId: string) {
  for (const row of storage.db
    .prepare('SELECT id FROM relationships WHERE (from_id=? OR to_id=?) AND valid_until IS NULL')
    .all(objectId, objectId))
    endRelationship(storage, String(row.id));
  for (const row of storage.db
    .prepare(
      `SELECT id FROM proposals WHERE status='pending' AND
    (json_extract(payload,'$.memory_id')=? OR json_extract(payload,'$.from_id')=? OR json_extract(payload,'$.to_id')=?)`,
    )
    .all(objectId, objectId, objectId)) {
    storage.db.prepare("UPDATE proposals SET status='rejected',resolved_at=? WHERE id=?").run(now(), row.id!);
    new Events(storage).append(
      'proposal.rejected',
      String(row.id),
      { reason: 'Referenced object deleted', object_id: objectId },
      { kind: 'user', actor: 'user', evidence: [objectId] },
    );
  }
}
