import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(root, '.toolchains/node-24.18.0.exe');
const sums = readFileSync(join(root, '.toolchains/node-SHASUMS256.txt'), 'utf8');
const expected = sums
  .split('\n')
  .find((line) => line.trim().endsWith('win-x64/node.exe'))
  ?.split(/\s+/)[0];
const actual = createHash('sha256').update(readFileSync(runtime)).digest('hex');
if (!expected || actual !== expected) throw new Error('Bundled Node runtime checksum mismatch');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run desktop:prepare');
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed`);
}
run(['run', 'build']);
const core = join(root, 'src-tauri/resources/core');
mkdirSync(core, { recursive: true });
const output = join(core, 'dist');
if (existsSync(output)) {
  const location = realpathSync(output);
  const boundary = realpathSync(core);
  const child = relative(boundary, location);
  if (!child || child.startsWith('..') || resolve(boundary, child) !== location)
    throw new Error('Unsafe desktop staging directory');
  rmSync(location, { recursive: true });
}
cpSync(join(root, 'dist'), join(core, 'dist'), { recursive: true });
// Install only backend runtime dependencies, with lifecycle scripts disabled.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimePackage = {
  name: 'mneme-core',
  version: pkg.version,
  private: true,
  type: 'module',
  dependencies: Object.fromEntries(
    ['@zip.js/zip.js', 'yaml', 'zod'].map((name) => [name, pkg.dependencies[name]]),
  ),
};
const serialized = JSON.stringify(runtimePackage, null, 2) + '\n';
const previous = existsSync(join(core, 'package.json'))
  ? readFileSync(join(core, 'package.json'), 'utf8')
  : '';
writeFileSync(join(core, 'package.json'), serialized);
if (previous !== serialized || !existsSync(join(core, 'node_modules/zod/package.json'))) {
  // Pin production transitive versions to the repository lock, then let npm prune UI/dev entries.
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  lock.name = runtimePackage.name;
  lock.version = runtimePackage.version;
  lock.packages[''] = runtimePackage;
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key && !Object.keys(runtimePackage.dependencies).some((name) => key === `node_modules/${name}`))
      delete lock.packages[key];
    else if (key) delete value.dev;
  }
  writeFileSync(join(core, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  run(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--cache', join(root, '.npm-cache')], core);
}
mkdirSync(join(root, 'src-tauri/binaries'), { recursive: true });
cpSync(runtime, join(root, 'src-tauri/binaries/mneme-core-x86_64-pc-windows-msvc.exe'));
cpSync(join(root, '.toolchains/NODE-LICENSE.txt'), join(core, 'NODE-LICENSE.txt'));
writeFileSync(
  join(core, 'runtime-manifest.json'),
  JSON.stringify({ node: '24.18.0', sha256: actual, platform: 'win-x64', app: pkg.version }, null, 2) + '\n',
);
console.log('Desktop core staged with verified, self-contained Node 24.18.0.');
