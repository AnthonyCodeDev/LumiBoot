#!/usr/bin/env node
// Génère un manifeste d'image conforme au schéma strict de @lumiboot/vm-assets
// (ref, architecture, memoryMiB, vgaMemoryMiB, license, files{disk,bzimage,initrd}).
// Les tailles et SHA-256 sont TOUJOURS calculés sur les fichiers réels : aucune
// valeur fictive n'est jamais écrite.
//
//   node images/debian-12-i386/write-manifest.mjs <dossier-artefacts>
//
// Paramétrable par variables d'environnement (utilisées par build.sh selon le
// flavor) ; les valeurs par défaut reproduisent EXACTEMENT l'image console
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
// Cmdline noyau optionnelle, propre au flavor (le flavor desktop y ajoute
// « vga=0x318 » pour disposer d'un framebuffer /dev/fb0, repli Xorg fbdev).
// Vide/absente → aucun champ `boot` : le provider applique son DEFAULT_BOOT_CMDLINE.
const CMDLINE = (process.env.IMAGE_CMDLINE ?? '').trim();
const LICENSE = 'Debian GNU/Linux — voir les notices de paquets (Debian Free Software Guidelines)';
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
    throw new Error(`Artefact manquant : ${path}. Construisez l'image avant de générer le manifeste.`);
  }
  // Hachage en flux : le disque fait 2 Gio, impossible à charger en mémoire
  // d'un coup (limite readFile > 2 Gio sur Node).
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

// Champ `boot` optionnel : présent uniquement si une cmdline a été fournie
// (flavor desktop). Le schéma @lumiboot/vm-assets valide `boot.cmdline`.
if (CMDLINE) {
  manifest.boot = { cmdline: CMDLINE };
}

const outPath = join(artifactsDir, 'manifest.json');
await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Manifeste écrit : ${outPath}`);
for (const [name, file] of Object.entries(files)) {
  console.log(`  ${name.padEnd(8)} ${String(file.size).padStart(12)} octets  sha256=${file.sha256}`);
}
