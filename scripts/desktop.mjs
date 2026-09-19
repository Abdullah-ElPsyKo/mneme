import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.');
const env = { ...process.env };
const searchPath = Object.entries(env)
  .filter(([key]) => key.toLowerCase() === 'path')
  .map(([, value]) => value)
  .join(';');
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = dirname(process.execPath) + ';' + searchPath;
if (existsSync(join(root, '.toolchains/cargo/bin/cargo.exe'))) {
  env.CARGO_HOME = join(root, '.toolchains/cargo');
  env.RUSTUP_HOME = join(root, '.toolchains/rustup');
  env.PATH = join(env.CARGO_HOME, 'bin') + ';' + env.PATH;
}
const result = spawnSync(
  process.execPath,
  ['node_modules/@tauri-apps/cli/tauri.js', ...process.argv.slice(2)],
  { env, stdio: 'inherit', windowsHide: true },
);
process.exit(result.status ?? 1);
