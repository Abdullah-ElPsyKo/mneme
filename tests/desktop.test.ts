import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Brain } from '../server/app.js';
import { temporary, removeTemporary } from './helpers.js';

function core(root: string) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (['path', 'node_options', 'node_path', 'mneme_api_key'].includes(name.toLowerCase())) delete env[name];
  // Exercise the distributable runtime without a Node/npm installation on PATH.
  env.PATH = process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin';
  const pinned = resolve('.toolchains/node-24.18.0.exe');
  const executable = process.platform === 'win32' && existsSync(pinned) ? pinned : process.execPath;
  assert.ok(existsSync(resolve('dist/server/desktop.js')), 'Build before running desktop integration tests');
  const child = spawn(executable, [resolve('dist/server/desktop.js'), root], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: any[] = [];
  const waiters: Array<{ predicate: (message: any) => boolean; resolve: (message: any) => void }> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  child.stderr.resume();
  const wait = (predicate: (message: any) => boolean) => {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop core response timed out')), 15000);
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };
  return { child, wait, send: (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n') };
}

test('Bundled desktop core preserves existing brains, authentication, hidden pause and graceful shutdown without Node on PATH', async () => {
  const root = temporary('desktop');
  let brain = new Brain(root);
  const original = brain.memories.save({
    title: 'Existing portable brain',
    body: 'Desktop migration must retain Markdown and history.',
  });
  await brain.close();
  const process = core(root);
  try {
    const ready = await process.wait((message) => message.type === 'ready');
    assert.match(ready.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(ready.token.length, 64);
    const headers = { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' };
    const request = (path: string, data?: unknown) =>
      fetch(ready.origin + '/api' + path, {
        headers,
        ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
      });
    assert.equal((await fetch(ready.origin + '/api/status')).status, 401);
    assert.equal(
      (await fetch(ready.origin + '/api/status', { headers: { ...headers, Origin: 'http://evil.invalid' } }))
        .status,
      403,
    );
    const page = await fetch(ready.origin);
    assert.match(
      page.headers.get('content-security-policy')!,
      /connect-src 'self' ipc: http:\/\/ipc.localhost/,
    );
    assert.doesNotMatch(page.headers.get('content-security-policy')!, /script-src[^;]*unsafe-inline/);
    assert.equal((await (await request(`/memories/${original.id}`)).json()).body, original.body);
    process.send({ type: 'visibility', suspended: true });
    await process.wait((message) => message.type === 'status' && message.suspended === true);
    const queued = await (await request('/jobs', { type: 'rebuild' })).json();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const jobs = await (await request('/jobs')).json();
    assert.equal(jobs.find((job: any) => job.id === queued.id).status, 'queued');
    assert.equal(
      (await (await request('/settings')).json()).background,
      true,
      'Hiding must not overwrite canonical settings',
    );
    process.send({ type: 'toggle-background' });
    await process.wait((message) => message.type === 'status' && message.background === false);
    process.send({ type: 'visibility', suspended: false, shell: 'forbidden' });
    await process.wait((message) => message.type === 'error');
    process.send({ type: 'status' });
    await process.wait((message) => message.type === 'status' && message.suspended === true);
    const capture = await (
      await request('/capture', { text: 'A thought captured from the native window' })
    ).json();
    assert.ok(capture.id);
    const exited = once(process.child, 'exit');
    process.send({ type: 'shutdown' });
    assert.equal((await exited)[0], 0);
    brain = new Brain(root);
    assert.equal(brain.memories.get(capture.id).body, 'A thought captured from the native window');
    assert.equal(brain.doctor(true).ok, true);
    assert.ok(existsSync(join(root, original.path)));
    await brain.close();
  } finally {
    if (process.child.exitCode === null) {
      process.child.kill();
      await once(process.child, 'exit');
    }
    removeTemporary(root);
  }
});

test('Desktop core exits when its private parent pipe closes and releases the owner lock', async () => {
  const root = temporary('desktop-parent');
  const process = core(root);
  try {
    await process.wait((message) => message.type === 'ready');
    const exited = once(process.child, 'exit');
    process.child.stdin.end();
    assert.equal((await exited)[0], 0);
    const reopened = new Brain(root);
    assert.equal(reopened.doctor(true).ok, true);
    await reopened.close();
  } finally {
    if (process.child.exitCode === null) {
      process.child.kill();
      await once(process.child, 'exit');
    }
    removeTemporary(root);
  }
});
