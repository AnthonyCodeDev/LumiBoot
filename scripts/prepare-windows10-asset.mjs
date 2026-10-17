#!/usr/bin/env node
// Prépare le manifeste du disque système Windows 10 x86 fourni LOCALEMENT par
// l'opérateur, destiné à être streamé vers v86 par HTTP Range.
//
// Ce script est un DÉLÉGANT : il ne réimplémente RIEN et se contente d'appeler
// le générateur éprouvé `scripts/prepare-windows7-asset.mjs` (même format de
// manifeste `LocalDiskManifest`, même SHA-256 en flux, même garantie « source
// jamais écrite ») en fixant les valeurs propres à Windows 10 x86
// (ref/display-name/architecture/mémoire/VGA/dossier de sortie/notes).
//
//   pnpm assets:windows10:prepare -- --source "D:\VM\Windows10-32bit.img"
//   pnpm assets:windows10:check
//   node scripts/prepare-windows10-asset.mjs --source D:\VM\win10.img --skip-hash
//   node scripts/prepare-windows10-asset.mjs --source D:\VM\win10.img --json
//
// Le disque est servi IN-PLACE : le manifeste enregistre `source.path` sur le
// fichier réel de l'opérateur (hors dépôt) et ne copie RIEN dans le dépôt.
// Le middleware de dev (`scripts/lib/disk-asset-dev.mjs`) découvre
// automatiquement le dossier `images/windows-10-x86/`, il n'y a rien à câbler.
//
// CONTRAINTE DE PIPELINE : Windows 10 démarre en `disk-boot` via `hda`
// asynchrone, donc le média DOIT être un disque RAW **déjà installé**. Une ISO
// seule n'est pas un disque de démarrage et un QCOW2 n'est pas un RAW : les
// deux sont refusés AVANT toute génération (aucun faux manifeste écrit).
//
// Options transférées telles quelles au générateur : --check, --force,
// --skip-hash, --resume, --json, --copy-to, etc. Les éventuelles options
// fournies par l'opérateur (dont --source) sont placées APRÈS les valeurs par
// défaut : elles les surchargent.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const generator = join(here, 'prepare-windows7-asset.mjs');

const REF = 'windows-10-x86';
const DISPLAY_NAME = 'Windows 10 x86';
const ARCHITECTURE = 'i386';
const MEMORY_MIB = '2048';
const VGA_MIB = '16';
const OUT_DIR = resolve(repoRoot, 'images', REF);
const DEFAULT_SOURCE = process.env.WINDOWS10_IMG ?? join(OUT_DIR, 'disk.img');

const NOTES = [
  `Disque RAW x86 de l’opérateur (Windows 10, déjà installé), servi in-place (images/${REF}/disk.img) : jamais copié, ignoré par Git, ni distribué.`,
  'Démarré par BIOS sous v86 via HTTP Range (hda.async = true), jamais en cdrom.',
];

/** Extensions de disques virtuels non bruts, refusées pour un boot `hda`. */
const NOT_RAW_EXTENSIONS = new Map([
  ['.qcow', 'QCOW'],
  ['.qcow2', 'QCOW2'],
  ['.vhd', 'VHD'],
  ['.vhdx', 'VHDX'],
  ['.vmdk', 'VMDK'],
  ['.vdi', 'VDI'],
]);

function usage() {
  return `Usage : node scripts/prepare-windows10-asset.mjs [options]

Générateur Windows 10 x86 (délègue à prepare-windows7-asset.mjs).

  --source <chemin>       Disque RAW x86 DÉJÀ INSTALLÉ (défaut :
                          images/${REF}/disk.img, ou WINDOWS10_IMG).
                          Une ISO seule ou un QCOW2 sont refusés.
  --out <dossier>         Dossier de sortie (défaut images/${REF})
  --check                 Vérifie le manifeste existant sans rien écrire
  --force                 Autorise l'écrasement du manifeste existant
  --skip-hash             Ne pas calculer le SHA-256 (documente taille + mtime)
  --resume                Réutilise le SHA-256 existant si taille+mtime identiques
  --json                  Imprime le manifeste sur stdout (logs sur stderr)
  --copy-to <chemin>      Copie vérifiée optionnelle (jamais la source, jamais public/)
  -h, --help              Affiche cette aide

Exemple :
  pnpm assets:windows10:prepare -- --source "D:\\\\VM\\\\Windows10-32bit.img"
`;
}

/** Dernière valeur d'une option `--nom valeur` ou `--nom=valeur` (dernier gagne). */
function lastValue(args, name) {
  let value;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      value = args[i + 1];
      i += 1;
    } else if (args[i].startsWith(`${name}=`)) {
      value = args[i].slice(name.length + 1);
    }
  }
  return value;
}

function hasFlag(args, ...names) {
  return args.some((arg) => names.includes(arg));
}

/**
 * Refuse tout média qui ne peut pas démarrer en `hda` asynchrone : ISO seule
 * (pas un disque) et formats conteneurs (QCOW/QCOW2/VHD/VMDK/VDI) non bruts.
 * Lève avant toute génération, donc aucun manifeste factice n'est écrit.
 */
function assertBootableRawDisk(sourcePath, requestedFormat) {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    throw new Error('Disc source manquant : fournissez --source <disque RAW> ou WINDOWS10_IMG.');
  }
  const format = (requestedFormat ?? '').toLowerCase();
  const extension = extname(sourcePath).toLowerCase();

  if (format === 'iso' || extension === '.iso') {
    throw new Error(
      'Refus : une image ISO seule n’est pas un disque de démarrage pour hda ' +
        '(pipeline disk-boot). Fournissez le disque RAW de Windows 10 déjà installé.',
    );
  }
  if (NOT_RAW_EXTENSIONS.has(extension)) {
    const kind = NOT_RAW_EXTENSIONS.get(extension);
    throw new Error(
      `Refus : format ${kind} non supporté par hda asynchrone (pipeline disk-boot exige un RAW). ` +
        'Convertissez d’abord le disque en RAW, puis relancez avec --source.',
    );
  }
  if (format !== '' && format !== 'raw') {
    throw new Error(`Refus : format « ${format} » non supporté (RAW requis pour disk-boot).`);
  }
}

function runGenerator(args) {
  const result = spawnSync(process.execPath, [generator, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`✗ Échec du lancement du générateur : ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  // Neutralise un `--` isolé injecté par `pnpm <script> -- <opts>` : il n'est ni
  // une option du wrapper ni une valeur, donc on le retire AVANT toute
  // validation et avant de le transmettre au générateur (qui le tolérerait
  // aussi, mais on évite ainsi toute ambiguïté avec `lastValue`/`hasFlag`).
  const userArgs = process.argv.slice(2).filter((arg) => arg !== '--');

  if (hasFlag(userArgs, '--help', '-h')) {
    process.stdout.write(usage());
    return 0;
  }

  const check = hasFlag(userArgs, '--check');

  // Valeurs propres à Windows 10 x86, puis options de l'opérateur (qui gagnent).
  const defaults = [
    '--ref',
    REF,
    '--display-name',
    DISPLAY_NAME,
    '--architecture',
    ARCHITECTURE,
    '--memory-mib',
    MEMORY_MIB,
    '--vga-mib',
    VGA_MIB,
    '--out',
    OUT_DIR,
    '--provenance',
    `images/${REF}/disk.img (disque local servi in-place)`,
    ...NOTES.flatMap((note) => ['--note', note]),
  ];
  // En vérification sans --source, on laisse le générateur suivre le chemin
  // enregistré dans le manifeste ; sinon on propose la source par défaut.
  if (!check) defaults.push('--source', DEFAULT_SOURCE);

  const args = [...defaults, ...userArgs];

  if (!check) {
    const source = lastValue(args, '--source') ?? DEFAULT_SOURCE;
    const format = lastValue(args, '--format');
    assertBootableRawDisk(source, format);

    const absoluteSource = resolve(source);
    if (!existsSync(absoluteSource)) {
      process.stderr.write(
        `✗ Aucune image locale « ${REF} » trouvée.\n` +
          `  Source attendue : ${absoluteSource}\n` +
          '  Préparez un disque RAW x86 déjà installé, puis relancez :\n' +
          `    pnpm assets:windows10:prepare -- --source "<chemin\\\\disk.img>"\n`,
      );
      return 1;
    }
  }

  return runGenerator(args);
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`✗ ${error.message}\n`);
  process.exitCode = 1;
}
