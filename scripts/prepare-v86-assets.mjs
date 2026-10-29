#!/usr/bin/env node
// Copies/downloads the v86 binaries into apps/web/public/v86/ and verifies them.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const publicDir = join(repoRoot, 'apps', 'web', 'public', 'v86');
const lock = JSON.parse(await readFile(join(here, 'v86-assets.lock.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function verifyIntegrity(name, bytes) {
  const expected = lock.assets[name];
  if (!expected) throw new Error(`No lock entry for "${name}".`);
  if (bytes.length !== expected.size) {
    throw new Error(`Invalid size for ${name}: ${bytes.length} (expected ${expected.size}).`);
  }
  const actual = sha256(bytes);
  if (actual !== expected.sha256) {
    throw new Error(`Invalid SHA-256 for ${name}: ${actual} (expected ${expected.sha256}).`);
  }
}

function findInstalledWasm() {
  const candidates = [
    join(repoRoot, 'packages', 'provider-v86', 'node_modules', 'v86', 'build', 'v86.wasm'),
    join(repoRoot, 'node_modules', 'v86', 'build', 'v86.wasm'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(
    'v86.wasm not found. Run "pnpm install" (v86 dependency of the provider-v86 package).',
  );
}

if (checkOnly) {
  let ok = true;
  for (const name of Object.keys(lock.assets)) {
    const target = join(publicDir, name);
    if (!existsSync(target)) {
      console.error(`✗ ${name} missing from apps/web/public/v86/`);
      ok = false;
      continue;
    }
    try {
      verifyIntegrity(name, await readFile(target));
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}: ${error.message}`);
      ok = false;
    }
  }
  process.exit(ok ? 0 : 1);
}

await mkdir(publicDir, { recursive: true });

const wasmBytes = await readFile(findInstalledWasm());
verifyIntegrity('v86.wasm', wasmBytes);
await writeFile(join(publicDir, 'v86.wasm'), wasmBytes);
console.log(`✓ v86.wasm (${wasmBytes.length} bytes)`);

for (const name of ['seabios.bin', 'vgabios.bin']) {
  const { url } = lock.assets[name];
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(name, bytes);
  await writeFile(join(publicDir, name), bytes);
  console.log(`✓ ${name} (${bytes.length} bytes)`);
}

console.log('\nv86 assets ready in apps/web/public/v86/.');
