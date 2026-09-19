// Build-time prerequisite only. Installed Mneme includes this runtime.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const version = '24.18.0';
const expected = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de';
const directory = resolve('.toolchains');
mkdirSync(directory, { recursive: true });
const runtime = join(directory, `node-${version}.exe`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
if (!existsSync(runtime) || digest(readFileSync(runtime)) !== expected) {
  const bytes = await download(`https://nodejs.org/dist/v${version}/win-x64/node.exe`);
  if (digest(bytes) !== expected)
    throw new Error('Official runtime checksum differs from the reviewed release pin');
  writeFileSync(runtime, bytes);
}
writeFileSync(join(directory, 'node-SHASUMS256.txt'), `${expected}  win-x64/node.exe\n`);
writeFileSync(
  join(directory, 'NODE-LICENSE.txt'),
  await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`),
);
console.log(`Verified Windows x64 Node ${version} runtime ready for packaging.`);
