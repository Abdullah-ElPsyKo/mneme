import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ZipWriter, ZipReader, Uint8ArrayReader, Uint8ArrayWriter, TextReader } from '@zip.js/zip.js';
import { z } from 'zod';
import { AppError } from '../core/types.js';
import { atomicWrite, hash, id, inside, now, parse } from '../core/util.js';
import type { Memories } from '../memory/memories.js';
import type { Settings } from '../security/settings.js';
import { writeMarkdown } from '../memory/markdown.js';
const manifestSchema = z.object({
  format: z.literal('mneme-backup-v1'),
  created_at: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(250000),
});
const validPath = (path: string) =>
  /^(database\/brain\.db|vault\/[\w./ -]+\.md|objects\/[a-f0-9]{2}\/[a-f0-9]{64}|config\/settings\.json)$/.test(
    path,
  ) &&
  !path.split('/').some((s) => s === '.' || s === '..' || s === '') &&
  !path.includes('\\');

export class Backups {
  active = false;
  constructor(
    readonly memories: Memories,
    readonly settings: Settings,
  ) {}
  async create(password?: string, reconcile = true) {
    if (this.active) throw new AppError(409, 'A backup is already running');
    this.active = true;
    try {
      return await this.createSnapshot(password, reconcile);
    } finally {
      this.active = false;
    }
  }
  private async createSnapshot(password?: string, reconcile = true) {
    if (password !== undefined && password.length < 12)
      throw new AppError(400, 'Use a backup passphrase of at least 12 characters');
    if (reconcile) {
      const result = this.memories.reconcile(true);
      if (result.errors.length) throw new AppError(409, 'Resolve vault reconciliation errors before backup');
      this.memories.flush();
    }
    const folder = this.settings.data.backup_directory
      ? resolve(this.settings.data.backup_directory)
      : inside(this.memories.storage.root, 'backups');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const snapshotId = id(),
      staging = inside(this.memories.storage.root, `backups/.snapshot-${snapshotId}`);
    mkdirSync(staging, { mode: 0o700 });
    const output = join(
      folder,
      `mneme-${now().replace(/[:.]/g, '-')}-${snapshotId.slice(0, 8)}${password ? '.encrypted' : ''}.zip`,
    );
    try {
      const dbPath = join(staging, 'brain.db');
      await sqliteBackup(this.memories.storage.db, dbPath);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const manifest: z.infer<typeof manifestSchema> = {
        format: 'mneme-backup-v1',
        created_at: now(),
        files: [],
      };
      const zip = new ZipWriter(
        Writable.toWeb(createWriteStream(output + '.partial', { mode: 0o600 })) as WritableStream,
        { password, encryptionStrength: 3, zipCrypto: false, useWebWorkers: false, level: 1 },
      );
      const addBytes = async (path: string, bytes: Uint8Array) => {
        if (!validPath(path)) throw new AppError(400, 'Unsupported canonical path in snapshot');
        manifest.files.push({ path, hash: hash(bytes), size: bytes.length });
        await zip.add(path, new Uint8ArrayReader(bytes));
      };
      try {
        await addBytes('database/brain.db', readFileSync(dbPath));
        // Use the snapshot's immutable revisions so concurrent edits cannot mix database and Markdown generations.
        for (const row of db.prepare('SELECT id,path FROM memories ORDER BY id').iterate()) {
          const event = db
            .prepare(
              "SELECT payload FROM events WHERE aggregate_id=? AND kind IN ('memory.created','memory.updated','memory.archived') ORDER BY seq DESC LIMIT 1",
            )
            .get(row.id!);
          if (!event) throw new AppError(500, 'Memory revision missing from snapshot');
          const memory = parse(event.payload).memory;
          await addBytes(String(row.path), Buffer.from(writeMarkdown(memory)));
        }
        for (const source of db.prepare('SELECT hash,size FROM sources').iterate()) {
          const digest = String(source.hash),
            bytes = readFileSync(this.memories.objects.path(digest));
          if (hash(bytes) !== digest) throw new AppError(500, 'Cannot back up a damaged original');
          await addBytes(`objects/${digest.slice(0, 2)}/${digest}`, bytes);
        }
        const config = {
          ...this.settings.data,
          provider: 'disabled',
          ai_background: false,
          local_only: true,
          backup_directory: '',
        };
        await addBytes('config/settings.json', Buffer.from(JSON.stringify(config, null, 2)));
        await zip.add('manifest.json', new TextReader(JSON.stringify(manifest, null, 2)));
        await zip.close();
      } catch (error) {
        try {
          await zip.close();
        } catch {}
        throw error;
      } finally {
        db.close();
      }
      await verifyBackup(output + '.partial', password);
      renameSync(output + '.partial', output);
      this.memories.storage.db
        .prepare('INSERT INTO backup_runs VALUES (?,?,?,?)')
        .run(snapshotId, output, now(), hash(JSON.stringify(manifest)));
      this.memories.events.append(
        'backup.created',
        snapshotId,
        { path: output, encrypted: !!password, files: manifest.files.length },
        { kind: 'user', actor: 'user', evidence: [] },
      );
      // Only prune snapshots recorded by this application in this exact destination directory.
      const old = this.memories.storage.db
        .prepare('SELECT * FROM backup_runs ORDER BY created_at DESC')
        .all()
        .filter((r) => dirname(String(r.path)) === folder)
        .slice(this.settings.data.backup_retention);
      for (const row of old) {
        const path = String(row.path);
        if (/^mneme-[\w.-]+\.zip$/.test(path.slice(folder.length + 1)) && existsSync(path)) unlinkSync(path);
        this.memories.storage.db.prepare('DELETE FROM backup_runs WHERE id=?').run(row.id!);
      }
      return {
        id: snapshotId,
        path: output,
        encrypted: !!password,
        files: manifest.files.length,
        size: statSync(output).size,
      };
    } finally {
      // Both paths are concrete descendants created by this method.
      if (relative(this.memories.storage.root, staging).startsWith('backups') && staging.includes(snapshotId))
        rmSync(staging, { recursive: true, force: true });
      if (existsSync(output + '.partial')) unlinkSync(output + '.partial');
    }
  }
  list() {
    return this.memories.storage.db
      .prepare('SELECT * FROM backup_runs ORDER BY created_at DESC LIMIT 100')
      .all();
  }
}
export async function verifyBackup(path: string, password?: string, destination?: string) {
  const archive = new ZipReader(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    password,
    useWebWorkers: false,
  });
  try {
    const entries = await archive.getEntries();
    if (
      entries.length > 250001 ||
      entries.some((e) => e.directory || (e.filename !== 'manifest.json' && !validPath(e.filename)))
    )
      throw new AppError(400, 'Invalid or unsafe snapshot paths');
    const names = entries.map((e) => e.filename);
    if (new Set(names).size !== names.length) throw new AppError(400, 'Duplicate snapshot entries');
    const entriesByName = new Map(entries.map((e) => [e.filename, e]));
    const manifestEntry = entries.find((e) => e.filename === 'manifest.json');
    if (!manifestEntry || manifestEntry.directory || manifestEntry.uncompressedSize > 64 * 1024 * 1024)
      throw new AppError(400, 'Missing or oversized backup manifest');
    const manifest = manifestSchema.parse(
      JSON.parse(
        Buffer.from(
          await manifestEntry.getData(new Uint8ArrayWriter(), { password, checkSignature: true }),
        ).toString('utf8'),
      ),
    );
    if (
      manifest.files.length !== entries.length - 1 ||
      new Set(manifest.files.map((f) => f.path)).size !== manifest.files.length ||
      !manifest.files.some((f) => f.path === 'database/brain.db')
    )
      throw new AppError(400, 'Invalid manifest membership');
    let total = 0;
    for (const file of manifest.files) {
      if (!validPath(file.path)) throw new AppError(400, 'Unsafe manifest path');
      const entry = entriesByName.get(file.path);
      if (!entry || entry.directory || entry.uncompressedSize !== file.size)
        throw new AppError(400, 'Snapshot entry size mismatch');
      total += file.size;
      if (
        file.size > (file.path === 'database/brain.db' ? 2_000_000_000 : 110_000_000) ||
        total > 16_000_000_000
      )
        throw new AppError(413, 'Snapshot exceeds restore safety limits');
      const bytes = await entry.getData(new Uint8ArrayWriter(), { password, checkSignature: true });
      if (hash(bytes) !== file.hash) throw new AppError(400, `Snapshot integrity failure: ${file.path}`);
      if (destination) atomicWrite(inside(destination, file.path), bytes);
    }
    return { valid: true, files: manifest.files.length, bytes: total, created_at: manifest.created_at };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'Backup could not be verified. Check the passphrase and archive integrity.');
  } finally {
    await archive.close();
  }
}
export async function restoreBackup(path: string, destination: string, password?: string) {
  const target = resolve(destination);
  if (existsSync(target))
    throw new AppError(409, 'Restore requires a new directory; existing brains are never overwritten');
  await verifyBackup(path, password);
  const staging = target + `.restore-${id()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const result = await verifyBackup(path, password, staging);
    const db = new DatabaseSync(inside(staging, 'database/brain.db'));
    let integrity: string, fk: any[];
    try {
      integrity = String(db.prepare('PRAGMA integrity_check').get()!.integrity_check);
      fk = db.prepare('PRAGMA foreign_key_check').all();
      db.exec("DELETE FROM outbox; UPDATE jobs SET status='queued' WHERE status='running';");
    } finally {
      db.close();
    }
    if (integrity !== 'ok' || fk.length) throw new AppError(400, 'Restored database failed integrity checks');
    if (existsSync(target)) throw new AppError(409, 'Restore destination appeared during verification');
    renameSync(staging, target);
    return { ...result, path: target };
  } catch (error) {
    if (staging.startsWith(target + '.restore-')) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
