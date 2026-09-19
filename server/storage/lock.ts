import { existsSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { inside, id } from '../core/util.js';
import { AppError } from '../core/types.js';
export function acquireLock(root: string) {
  const path = inside(root, 'database/owner.lock'),
    nonce = id();
  if (existsSync(path)) {
    let previous: any;
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new AppError(
        409,
        'Unreadable brain lock. Run doctor after checking no service is using this brain.',
      );
    }
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error: any) {
      if (error.code === 'ESRCH') alive = false;
    }
    if (alive)
      throw new AppError(
        409,
        'This brain is already open in another process. Use the running UI/API, or stop its service before using a direct CLI command.',
      );
    unlinkSync(path);
  }
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  } finally {
    closeSync(fd);
  }
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) unlinkSync(path);
  };
}
