#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicDir = join(repoRoot, 'apps', 'web', 'public', 'v64');
const lock = JSON.parse(await readFile(join(here, 'v64-assets.lock.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function verify(name, bytes) {
  const expected = lock.assets[name];
  if (!expected) throw new Error(`No lock entry for "${name}".`);
  if (bytes.length !== expected.size) throw new Error(`${name}: ${bytes.length} bytes instead of ${expected.size}.`);
  const actual = sha256(bytes);
  if (actual !== expected.sha256) throw new Error(`${name}: SHA-256 ${actual} instead of ${expected.sha256}.`);
}

let ok = true;
for (const [name, asset] of Object.entries(lock.assets)) {
  const target = join(publicDir, name);
  try {
    let bytes;
    if (existsSync(target)) bytes = await readFile(target);
    else if (checkOnly) throw new Error('missing');
    else {
      const response = await fetch(asset.url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${asset.url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    verify(name, bytes);
    if (!checkOnly && !existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    ok = false;
  }
}
if (!ok) process.exit(1);
console.log(`\nv64 ${lock.revision} assets are ready in apps/web/public/v64/.`);
