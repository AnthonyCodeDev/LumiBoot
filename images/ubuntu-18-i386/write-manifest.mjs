#!/usr/bin/env node
// Generates the image manifest for the @lumiboot/vm-assets schema. Sizes and
// SHA-256 are always computed from the real files.
//
//   node images/ubuntu-18-i386/write-manifest.mjs <artifacts-dir>
//
// IMAGE_REF, IMAGE_ARCH, IMAGE_MEMORY_MIB, IMAGE_VGA_MIB and IMAGE_CMDLINE
// override the defaults, which reproduce the console image.

import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';

const REF = process.env.IMAGE_REF ?? 'ubuntu-18-i386';
const ARCH = process.env.IMAGE_ARCH ?? 'i386';
const MEMORY_MIB = Number(process.env.IMAGE_MEMORY_MIB ?? 512);
const VGA_MIB = Number(process.env.IMAGE_VGA_MIB ?? 16);
// Optional kernel cmdline; empty means no `boot` field.
const CMDLINE = (process.env.IMAGE_CMDLINE ?? '').trim();
const LICENSE = 'Ubuntu — free software, see /usr/share/doc/*/copyright (Ubuntu licensing)';
const BASE_URL = `/images/${REF}`;

const FILES = {
  disk: 'rootfs.img',
  bzimage: 'vmlinuz-686',
  initrd: 'initrd.img',
};

const artifactsDir = resolve(process.argv[2] ?? 'build');

async function describe(fileName) {
  const path = join(artifactsDir, fileName);
  const info = await stat(path).catch(() => null);
  if (!info) {
    throw new Error(`Missing artifact: ${path}. Build the image before generating the manifest.`);
  }
  // Streamed: the disk is several GiB.
  const sha256 = await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
  return { url: `${BASE_URL}/${fileName}`, sha256, size: info.size };
}

const files = {};
for (const [targetName, fileName] of Object.entries(FILES)) {
  files[targetName] = await describe(fileName);
}

const manifest = {
  ref: REF,
  architecture: ARCH,
  memoryMiB: MEMORY_MIB,
  vgaMemoryMiB: VGA_MIB,
  license: LICENSE,
  files,
};

// `boot` is present only when a cmdline was provided.
if (CMDLINE) {
  manifest.boot = { cmdline: CMDLINE };
}

const outPath = join(artifactsDir, 'manifest.json');
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Manifest written: ${outPath}`);
for (const [name, file] of Object.entries(files)) {
  console.log(`  ${name.padEnd(8)} ${String(file.size).padStart(12)} bytes  sha256=${file.sha256}`);
}
