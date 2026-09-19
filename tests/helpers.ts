import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { Brain } from '../server/app.js';
export function temporary(prefix = 'case') {
  const base = resolve('.test-brains');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, prefix + '-'));
}
export function removeTemporary(path: string) {
  const base = resolve('.test-brains'),
    rel = relative(base, resolve(path));
  if (!rel || rel.startsWith('..')) throw new Error('Refusing cleanup outside test workspace');
  rmSync(path, { recursive: true, force: true });
}
export async function withBrain(fn: (brain: Brain) => Promise<void> | void) {
  const root = temporary();
  const brain = new Brain(root);
  try {
    await fn(brain);
  } finally {
    await brain.close();
    removeTemporary(root);
  }
}
