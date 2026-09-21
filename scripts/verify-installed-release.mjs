import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const install = process.argv[2];
const version = process.argv[3];
assert.ok(install && version, 'Usage: node scripts/verify-installed-release.mjs INSTALL_DIRECTORY VERSION');
assert.equal(JSON.parse(readFileSync(join(install, 'core/package.json'), 'utf8')).version, version);
const base = resolve('.test-brains');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'installed-release-'));
const env = { ...process.env };
for (const key of Object.keys(env))
  if (['path', 'node_options', 'node_path', 'mneme_api_key'].includes(key.toLowerCase())) delete env[key];
env.PATH = `${process.env.SystemRoot}\\System32`;
const child = spawn(join(install, 'mneme-core.exe'), [join(install, 'core/dist/server/desktop.js'), root], {
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
const startup = new Promise((resolveReady, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => reject(new Error(`Core exited before readiness (${code})`)));
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === 'ready') resolveReady(message);
    } catch (error) {
      reject(error);
    }
  });
});
const timer = setTimeout(() => child.kill(), 30000);
try {
  const ready = await startup;
  const call = async (path, method = 'GET', data) => {
    const response = await fetch(ready.origin + '/api' + path, {
      method,
      headers: { Authorization: `Bearer ${ready.token}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  assert.equal((await fetch(ready.origin + '/api/status')).status, 401);
  assert.equal((await fetch(ready.origin)).status, 200);
  const project = await call('/memories', 'POST', { title: 'Installed release fixture', type: 'project' });
  assert.equal(project.project_state, 'planned');
  const note = await call('/memories', 'POST', {
    title: 'Associated fixture',
    project: project.title,
    status: 'inbox',
  });
  const { id, version: revision, path, content_hash, created_at, updated_at, ...input } = project;
  const changed = await call('/memories/' + id, 'PUT', {
    ...input,
    project_state: 'abandoned',
    expected_version: revision,
  });
  assert.equal(changed.project_state, 'abandoned');
  assert.equal((await call('/memories?type=project&project_state=active')).length, 0);
  assert.equal((await call('/memories?type=project&project_state=abandoned'))[0].id, id);
  assert.deepEqual(await call('/memories/' + note.id), note);
  assert.equal((await call('/events?aggregate=' + id)).length, 2);
  assert.equal((await call('/doctor?deep=true')).ok, true);
  child.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n');
  const [code] = await exited;
  assert.equal(code, 0);
  console.log(
    `Installed Mneme ${version}: authenticated core, UI serving, project lifecycle, associations, history, Doctor and graceful shutdown passed.`,
  );
} finally {
  clearTimeout(timer);
  lines.close();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await exited;
  }
  const childPath = relative(base, resolve(root));
  assert.ok(childPath && !childPath.startsWith('..'), 'Unsafe test cleanup path');
  rmSync(root, { recursive: true, force: true });
}
