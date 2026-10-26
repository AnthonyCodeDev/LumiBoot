#!/usr/bin/env node
// Generates an image manifest compliant with the strict @lumiboot/vm-assets
// schema (ref, architecture, memoryMiB, vgaMemoryMiB, license,
// files{disk,bzimage,initrd}).
// Sizes and SHA-256 are ALWAYS computed from the real files: no fictitious value
// is ever written.
//
//   node images/debian-12-i386/write-manifest.mjs <artifacts-dir>
//
// Configurable through environment variables (used by build.sh depending on the
// flavor); the default values reproduce EXACTLY the console image
// `debian-12-i386` :
//   IMAGE_REF=debian-12-i386-desktop IMAGE_MEMORY_MIB=1024 node write-manifest.mjs build-desktop

import { createHash } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';

const REF = process.env.IMAGE_REF ?? 'debian-12-i386';
const ARCH = process.env.IMAGE_ARCH ?? 'i386';
const MEMORY_MIB = Number(process.env.IMAGE_MEMORY_MIB ?? 512);
const VGA_MIB = Number(process.env.IMAGE_VGA_MIB ?? 16);
// Optional kernel cmdline, specific to the flavor (the desktop flavor adds
// "vga=0x318" to get a /dev/fb0 framebuffer, Xorg fbdev fallback).
// Empty/absent -> no `boot` field: the provider applies its DEFAULT_BOOT_CMDLINE.
const CMDLINE = (process.env.IMAGE_CMDLINE ?? '').trim();
const LICENSE = 'Debian GNU/Linux — see the package notices (Debian Free Software Guidelines)';
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
  // Streaming hash: the disk is 2 GiB, impossible to load into memory in one
  // go (readFile limit > 2 GiB on Node).
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

// Optional `boot` field: present only when a cmdline was provided (desktop
// flavor). The @lumiboot/vm-assets schema validates `boot.cmdline`.
if (CMDLINE) {
  manifest.boot = { cmdline: CMDLINE };
}

const outPath = join(artifactsDir, 'manifest.json');
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Manifest written: ${outPath}`);
for (const [name, file] of Object.entries(files)) {
  console.log(`  ${name.padEnd(8)} ${String(file.size).padStart(12)} bytes  sha256=${file.sha256}`);
}
