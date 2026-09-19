import { existsSync, readFileSync } from 'node:fs';
import type { Storage } from '../storage/database.js';
import { atomicWrite, hash, id, inside, now, parse, safeFilename } from '../core/util.js';
import { AppError } from '../core/types.js';
import { activeObject } from '../memory/lifecycle.js';
import { erased, assertErasureComplete } from '../memory/erasure.js';
import { readMarkdown } from '../memory/markdown.js';
export class Objects {
  constructor(readonly storage: Storage) {}
  path(digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new AppError(400, 'Invalid object hash');
    return inside(this.storage.root, `objects/${digest.slice(0, 2)}/${digest}`);
  }
  put(name: string, data: Uint8Array, mime = 'application/octet-stream', metadata: object = {}) {
    assertErasureComplete(this.storage);
    if (data.length > 100 * 1024 * 1024) throw new AppError(413, 'Maximum import size is 100 MiB');
    const digest = hash(data);
    if (erased(this.storage, 'bytes', digest))
      throw new AppError(409, 'This original was permanently erased from this brain');
    if (/\.md$|\.markdown$/i.test(name) || mime === 'text/markdown') {
      const metadata = readMarkdown(Buffer.from(data).toString('utf8')).metadata;
      if (metadata.id && erased(this.storage, 'id', String(metadata.id)))
        throw new AppError(409, 'This memory was permanently erased from this brain');
    }
    const existing = this.storage.db.prepare('SELECT * FROM sources WHERE hash=?').get(digest);
    if (existing) {
      const path = this.path(digest);
      if (!existsSync(path) || hash(readFileSync(path)) !== digest)
        throw new AppError(
          500,
          'The existing original failed integrity verification. Run Doctor before importing it again.',
        );
      return { ...this.decode(existing), duplicate: true };
    }
    const path = this.path(digest);
    if (existsSync(path)) {
      if (hash(readFileSync(path)) !== digest) throw new AppError(500, 'Object integrity mismatch');
    } else atomicWrite(path, data);
    const source = {
      id: id(),
      hash: digest,
      name: safeFilename(name),
      mime: mime.slice(0, 200),
      size: data.length,
      created_at: now(),
      metadata,
      memory_id: null,
    };
    this.storage.db
      .prepare('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)')
      .run(
        source.id,
        digest,
        source.name,
        source.mime,
        source.size,
        source.created_at,
        JSON.stringify(metadata),
        null,
      );
    return { ...source, duplicate: false };
  }
  decode(row: any) {
    return { ...row, metadata: parse(row.metadata) };
  }
  get(sourceId: string) {
    const row = this.storage.db.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
    if (!row) throw new AppError(404, 'Source not found');
    return this.decode(row);
  }
  list(limit = 100, offset = 0) {
    return this.storage.db
      .prepare(
        `SELECT * FROM sources WHERE ${activeObject('source', 'sources.id')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.min(limit, 500), offset)
      .map((row) => this.decode(row));
  }
}
