import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError } from './types.js';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const parse = <T = any>(value: unknown): T =>
  typeof value === 'string' ? JSON.parse(value) : (value as T);
export function inside(root: string, path: string): string {
  const base = resolve(root),
    target = resolve(base, path),
    rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new AppError(400, 'Path must be a child of the brain directory');
  let cursor = target;
  while (cursor !== base) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new AppError(400, 'Symbolic links are not allowed in managed storage');
    cursor = dirname(cursor);
  }
  if (existsSync(base) && realpathSync(base) !== resolve(base)) {
    // The root itself may be selected through a resolved user directory; callers normalize it at initialization.
  }
  return target;
}
export function atomicWrite(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const dir = openSync(dirname(path), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function safeFilename(name: string) {
  return name.replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').slice(0, 240) || 'import';
}
export function tokens(text: string) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] ** 2;
    nb += b[i] ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
