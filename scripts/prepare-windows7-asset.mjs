#!/usr/bin/env node
// Prépare le manifeste d'un disque système fourni LOCALEMENT (ex. Windows 7
// Professionnel SP1 x86) destiné à être streamé vers v86 par HTTP Range, sans
// jamais le copier dans public/ ni le committer.
//
//   node scripts/prepare-windows7-asset.mjs
//   node scripts/prepare-windows7-asset.mjs --source D:\media\winxp.img \
//       --ref windows-xp-x86 --display-name "Windows XP x86" --architecture i386
//   node scripts/prepare-windows7-asset.mjs --check
//   node scripts/prepare-windows7-asset.mjs --skip-hash   # documente méthode+taille+mtime
//
// Le disque est servi IN-PLACE : le manifeste enregistre `source.path` RELATIF à
// la racine du dépôt (ex. `images/windows-7-x86/disk.img`, séparateurs `/`) et
// ne copie RIEN dans le dépôt. Un disque HORS dépôt (ex. `--source D:\media\x.img`)
// n'enregistre AUCUN chemin : `source` devient `{ external: true, size, mtimeMs }`.
// Un chemin absolu local (lettre de lecteur + dossier personnel) n'a aucune
// valeur sur une autre machine et ne doit jamais être publié ; `--check` réclame
// alors explicitement `--source`.
//
// Garanties :
//   - le fichier source est ouvert en LECTURE SEULE et n'est JAMAIS modifié,
//     tronqué ni écrasé (aucune écriture n'a ce chemin pour cible) ;
//   - la copie optionnelle (`--copy-to`) est refusée si elle viserait la source
//     elle-même ou un dossier `public/`, et n'est écrite qu'après vérification
//     du SHA-256 calculé en flux ;
//   - l'empreinte SHA-256 est calculée en streaming (8 Mio par bloc), jamais en
//     chargeant les 32 Gio en mémoire ;
//   - la sortie par défaut `images/<ref>/` est ignorée par Git.
//
// Le manifeste produit est validé par `parseLocalDiskManifest` (tests
// `packages/vm-assets/src/local-disk.test.ts` et `tests/prepare-windows7-asset.test.ts`).

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const lockPath = join(here, 'v86-assets.lock.json');
const CHUNK = 8 * 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const DEFAULTS = {
  source: process.env.WINDOWS7_IMG ?? join(repoRoot, 'images', 'windows-7-pro-sp1-x86', 'disk.img'),
  ref: 'windows-7-pro-sp1-x86',
  displayName: 'Windows 7 Professionnel SP1 x86',
  architecture: 'i386',
  // Windows 7 (Vista+) exige au moins 512 Mio ; 1536 Mio est requis par
  // l'invité installé sous QEMU et accepté par v86 (arrondi à 128 Kio).
  memoryMiB: 1536,
  vgaMiB: 16,
  license: 'Disque RAW local de la codebase (non distribué)',
  provenance: 'images/windows-7-pro-sp1-x86/disk.img (disque local servi in-place)',
  servedName: 'disk.img',
  notes: [
    'Disque RAW 32 Gio de l’opérateur, servi in-place (images/windows-7-pro-sp1-x86/disk.img) : jamais copié, ignoré par Git, committé ni distribué.',
    'Démarré par BIOS sous v86 via HTTP Range (hda.async = true), jamais en cdrom.',
  ],
};

const ARCHITECTURES = new Set(['i386', 'x86', 'x86_64', 'arm', 'arm64', 'powerpc', 'm68k']);

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  const flags = {
    skipHash: false,
    check: false,
    json: false,
    resume: false,
    help: false,
    force: false,
    sourceProvided: false,
  };
  let copyTo;
  let outDir;
  let notes;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // Tolérance ergonomique : un `--` isolé, injecté par `pnpm <script> -- <opts>`,
    // est ignoré comme le ferait un parseur d'arguments standard (jamais traité
    // comme une option inconnue). Il peut toutefois rester la VALEUR explicite
    // d'une option à argument (ex. `--note --`) via `value()`, cas inchangé.
    if (arg === '--') continue;
    const [name, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw new Error(`Option ${name} sans valeur.`);
      return argv[i];
    };
    switch (name) {
      case '--source': options.source = value(); flags.sourceProvided = true; break;
      case '--ref': options.ref = value(); break;
      case '--display-name': options.displayName = value(); break;
      case '--architecture': options.architecture = value(); break;
      case '--memory-mib': options.memoryMiB = Number(value()); break;
      case '--vga-mib': options.vgaMiB = Number(value()); break;
      case '--license': options.license = value(); break;
      case '--provenance': options.provenance = value(); break;
      case '--served-name': options.servedName = value(); break;
      case '--format': options.format = value(); break;
      case '--note': (notes ??= []).push(value()); break;
      case '--out': outDir = value(); break;
      case '--copy-to': copyTo = value(); break;
      case '--skip-hash': flags.skipHash = true; break;
      case '--resume': flags.resume = true; break;
      case '--check': flags.check = true; break;
      case '--json': flags.json = true; break;
      case '--force': flags.force = true; break;
      case '--help': case '-h': flags.help = true; break;
      default:
        throw new Error(`Option inconnue : ${name}`);
    }
  }
  // `--note` (répétable) remplace les notes par défaut ; sans option, on garde
  // les notes Windows 7 de `DEFAULTS` (comportement historique inchangé).
  if (notes !== undefined) options.notes = notes;
  return { options, flags, copyTo, outDir };
}

function usage() {
  return `Usage : node scripts/prepare-windows7-asset.mjs [options]

  --source <chemin>       Image disque source (défaut :
                          images/windows-7-pro-sp1-x86/disk.img à la racine du
                          dépôt, ou WINDOWS7_IMG / --source pour la surcharger).
                          Un chemin relatif est résolu depuis le dossier courant ;
                          un disque hors dépôt n'enregistre aucun chemin local.
  --ref <ref>             Référence (minuscules/tirets), ex. windows-7-pro-sp1-x86
  --display-name <nom>    Libellé lisible
  --architecture <arch>   i386 (défaut), x86_64, …
  --memory-mib <n>        Mémoire invitée conseillée (défaut 1536)
  --vga-mib <n>           Mémoire VGA (défaut 16)
  --license <texte>       Rappel de licence
  --provenance <texte>    Origine du média
  --served-name <nom>     Nom servi sous /images/<ref>/ (défaut disk.img)
  --format <raw|iso>      Format (défaut : déduit de l'extension)
  --note <texte>          Note du manifeste (répétable ; remplace les notes par défaut)
  --out <dossier>         Dossier de sortie (défaut images/<ref>)
  --copy-to <chemin>      Copie vérifiée optionnelle (jamais la source, jamais public/)
  --skip-hash             Ne pas calculer le SHA-256 (documente taille + mtime)
  --resume                Réutiliser le SHA-256 d'un manifeste existant si taille+mtime identiques
  --check                 Vérifier le manifeste existant sans rien écrire
                          (suit « source.path », relatif à la racine du dépôt ;
                          réclame --source pour un disque externe)
  --json                  Imprimer le manifeste sur stdout (logs sur stderr)
  --force                 Autoriser l'écrasement du manifeste existant

Chemins enregistrés : le manifeste ne contient JAMAIS de chemin absolu. Un disque
situé dans le dépôt est noté relativement (ex. images/<ref>/disk.img) ; un disque
externe est noté « external: true » sans chemin, et --check réclame --source.
`;
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Convertit un chemin en chemin RELATIF à la racine du dépôt, séparateurs `/`
 * (ex. `images/windows-7-x86/disk.img`). Retourne `null` si le fichier est hors
 * du dépôt : un chemin absolu propre à la machine de l'opérateur ne doit jamais
 * entrer dans le manifeste ni dans `provenance.txt` (rien ne serait réutilisable
 * ailleurs, et le dépôt ne doit publier aucun chemin local).
 *
 * @param {string} filePath chemin absolu ou relatif au cwd
 * @returns {string | null} chemin relatif à la racine du dépôt, ou null
 */
function toRepoRelativePath(filePath) {
  const absolute = resolve(filePath);
  const rel = relative(repoRoot, absolute);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * Résout un chemin ENREGISTRÉ dans un manifeste. Un chemin relatif l'est
 * toujours par rapport à la RACINE DU DÉPÔT (jamais au cwd : Vite et pnpm
 * tournent depuis `apps/web` ou un sous-dossier) ; un chemin absolu hérité d'un
 * ancien manifeste est utilisé tel quel.
 *
 * @param {string} recordedPath chemin enregistré dans `source.path`
 * @returns {string} chemin absolu
 */
function resolveRecordedPath(recordedPath) {
  return isAbsolute(recordedPath) ? recordedPath : resolve(repoRoot, recordedPath);
}

/** Refuse toute cible située dans un dossier `public/` (bundle Vite). */
function assertNotPublic(path, label) {
  const normalized = resolve(path).toLowerCase().split('\\').join('/');
  if (normalized.includes('/public/')) {
    throw new Error(`Refus : ${label} ne doit jamais être écrit dans un dossier public/ (${path}).`);
  }
}

function detectFormat(sourcePath, explicit) {
  const format = (explicit ?? (extname(sourcePath).toLowerCase() === '.iso' ? 'iso' : 'raw')).toLowerCase();
  if (format !== 'raw' && format !== 'iso') {
    throw new Error(`Format inconnu « ${format} » (attendu : raw ou iso).`);
  }
  return format;
}

/**
 * Calcule le SHA-256 en streaming. Le fichier est ouvert en lecture seule.
 * `onProgress(lus, total)` est appelé à chaque bloc.
 */
async function sha256File(filePath, { onProgress, timeoutMs } = {}) {
  const hash = createHash('sha256');
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let read = 0;
  try {
    const stream = createReadStream(filePath, { highWaterMark: CHUNK });
    for await (const chunk of stream) {
      if (controller.signal.aborted) throw new Error('Délai de hachage dépassé.');
      hash.update(chunk);
      read += chunk.length;
      onProgress?.(read);
    }
    return { sha256: hash.digest('hex'), size: read };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Copie vérifiée : copie dans un `.part` puis renomme ; hash calculé en flux. */
async function copyAndHash(sourcePath, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const hash = createHash('sha256');
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(sourcePath), hasher, createWriteStream(temporary));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const info = await stat(destination);
  return { sha256: hash.digest('hex'), size: info.size };
}

function engineFromLock(lock) {
  const bin = (name, url) => {
    const entry = lock.assets[name];
    if (!entry) throw new Error(`Verrou v86 incomplet : « ${name} » absent.`);
    return { url, size: entry.size, sha256: entry.sha256 };
  };
  return {
    id: 'v86',
    wasm: bin('v86.wasm', '/v86/v86.wasm'),
    bios: {
      seabios: bin('seabios.bin', '/v86/seabios.bin'),
      vgabios: bin('vgabios.bin', '/v86/vgabios.bin'),
    },
  };
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readExistingManifest(outDir) {
  const manifestPath = join(outDir, 'manifest.json');
  if (!(await fileExists(manifestPath))) return null;
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const { options, flags, copyTo, outDir } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (!ARCHITECTURES.has(options.architecture)) {
    throw new Error(`Architecture invalide « ${options.architecture} ».`);
  }
  if (!Number.isInteger(options.memoryMiB) || options.memoryMiB <= 0) {
    throw new Error('--memory-mib doit être un entier positif.');
  }
  if (!Number.isInteger(options.vgaMiB) || options.vgaMiB <= 0) {
    throw new Error('--vga-mib doit être un entier positif.');
  }
  if (!/^[a-z0-9-]+$/.test(options.ref)) {
    throw new Error(`Référence invalide « ${options.ref} » (minuscules, chiffres, tirets).`);
  }

  const outputDir = resolve(outDir ?? join(repoRoot, 'images', options.ref));
  const manifestPath = join(outputDir, 'manifest.json');

  // En vérification sans --source explicite, on suit le chemin enregistré dans
  // le manifeste (chemin RELATIF à la racine du dépôt, ou absolu hérité d'un
  // ancien manifeste). Un manifeste issu d'un disque EXTERNE n'enregistre aucun
  // chemin : il faut alors fournir --source explicitement.
  let sourcePath = resolve(options.source);
  if (flags.check && !flags.sourceProvided) {
    const recorded = await readExistingManifest(outputDir);
    const recordedPath = recorded?.source?.path;
    if (typeof recordedPath === 'string' && recordedPath.length > 0) {
      sourcePath = resolveRecordedPath(recordedPath);
    } else if (recorded?.source?.external === true) {
      throw new Error(
        'Ce manifeste a été généré depuis un disque HORS du dépôt : aucun chemin local n’y est ' +
          'enregistré (il ne doit jamais être publié). Relancez la vérification avec --source :\n' +
          '  node scripts/prepare-windows7-asset.mjs --check --source "<disque>"',
      );
    }
  }

  await access(sourcePath, fsConstants.R_OK).catch(() => {
    throw new Error(`Source introuvable ou illisible : ${sourcePath}`);
  });
  const sourceInfo = await stat(sourcePath);
  if (!sourceInfo.isFile()) throw new Error(`La source n'est pas un fichier : ${sourcePath}`);
  if (!Number.isInteger(sourceInfo.size) || sourceInfo.size <= 0) {
    throw new Error(`Taille source invalide : ${sourceInfo.size}`);
  }
  const format = detectFormat(sourcePath, options.format);

  // ---- Mode vérification -------------------------------------------------
  if (flags.check) {
    const existing = await readExistingManifest(outputDir);
    if (!existing) throw new Error(`Aucun manifeste à vérifier dans ${outputDir}.`);
    const problems = [];
    if (existing.source?.size !== sourceInfo.size) {
      problems.push(`taille source : ${sourceInfo.size} != manifeste ${existing.source?.size}`);
    }
    if (Math.trunc(existing.source?.mtimeMs ?? -1) !== Math.trunc(sourceInfo.mtimeMs)) {
      problems.push(
        `mtime source : ${Math.trunc(sourceInfo.mtimeMs)} != manifeste ${Math.trunc(existing.source?.mtimeMs ?? -1)}`,
      );
    }
    if (existing.disk?.size !== sourceInfo.size) {
      problems.push(`taille disque : ${sourceInfo.size} != manifeste ${existing.disk?.size}`);
    }
    if (existing.disk?.sha256 && !flags.skipHash) {
      log('→ Vérification du SHA-256 (streaming)…');
      const result = await sha256File(sourcePath, {
        onProgress: makeProgress(sourceInfo.size),
        timeoutMs: 30 * 60 * 1000,
      });
      if (result.sha256 !== existing.disk.sha256) {
        problems.push(`SHA-256 : ${result.sha256} != manifeste ${existing.disk.sha256}`);
      }
      log(`  sha256=${result.sha256}`);
    } else if (existing.disk?.sha256 === undefined) {
      log('ℹ Manifeste sans SHA-256 (documenté par taille + mtime).');
    }
    if (problems.length > 0) {
      for (const problem of problems) log(`✗ ${problem}`);
      return 1;
    }
    log(`✓ Manifeste conforme : ${manifestPath}`);
    return 0;
  }

  // ---- Mode génération ---------------------------------------------------
  assertNotPublic(outputDir, 'le dossier de sortie');
  if (copyTo !== undefined) assertNotPublic(copyTo, 'la copie disque');

  const sourceReal = resolve(sourcePath).toLowerCase();
  if (copyTo !== undefined && resolve(copyTo).toLowerCase() === sourceReal) {
    throw new Error('Refus d’écrire sur la source : --copy-to ne peut pas être le fichier source.');
  }

  const priorManifest = await readExistingManifest(outputDir);
  if (priorManifest && !flags.force) {
    throw new Error(
      `Un manifeste existe déjà (${manifestPath}). Utilisez --check pour le vérifier ou --force pour le régénérer.`,
    );
  }

  const progress = makeProgress(sourceInfo.size);
  let sha256;
  let hashSource = sourcePath;

  if (flags.skipHash) {
    log('ℹ --skip-hash : SHA-256 non calculé. Méthode documentée : `sha256sum` sur le fichier source.');
  } else {
    const reusable =
      flags.resume &&
      priorManifest?.disk?.sha256 &&
      priorManifest?.source?.size === sourceInfo.size &&
      Math.trunc(priorManifest?.source?.mtimeMs) === Math.trunc(sourceInfo.mtimeMs);
    if (reusable) {
      sha256 = priorManifest.disk.sha256;
      log(`✓ SHA-256 réutilisé depuis le manifeste existant : ${sha256}`);
    } else {
      log(`→ Calcul du SHA-256 en streaming de ${sourcePath}…`);
      const result = await sha256File(sourcePath, {
        onProgress: progress,
        timeoutMs: 30 * 60 * 1000,
      });
      sha256 = result.sha256;
      if (result.size !== sourceInfo.size) {
        throw new Error(
          `La lecture a renvoyé ${result.size} octets alors que stat en annonce ${sourceInfo.size}.`,
        );
      }
      log(`\n  sha256=${sha256}`);
    }
  }

  // Copie vérifiée optionnelle (jamais nécessaire pour v86 : RAW lu directement).
  if (copyTo !== undefined) {
    if (sha256 === undefined) {
      throw new Error('--copy-to exige le SHA-256 (retirez --skip-hash) pour vérifier la copie.');
    }
    const destination = resolve(copyTo);
    log(`→ Copie vérifiée vers ${destination}…`);
    const copied = await copyAndHash(sourcePath, destination);
    if (copied.size !== sourceInfo.size || copied.sha256 !== sha256) {
      await rm(destination, { force: true });
      throw new Error(
        `Copie invalide : ${copied.size} octets / sha256=${copied.sha256} ; original non modifié.`,
      );
    }
    log(`✓ Copie vérifiée (${copied.size} octets, sha256 identique).`);
    hashSource = destination;
  }

  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const diskUrl = `/images/${options.ref}/${options.servedName}`;
  const diskMtimeMs = Math.trunc(sourceInfo.mtimeMs);

  // Aucun chemin absolu n'est écrit : chemin relatif à la racine du dépôt si le
  // disque y vit, sinon simple marqueur « external » (taille + mtime suffisent
  // à re-détecter le fichier, sans publier l'arborescence de l'opérateur).
  const sourceRelative = toRepoRelativePath(hashSource);
  const source = sourceRelative === null
    ? { external: true, size: sourceInfo.size, mtimeMs: diskMtimeMs }
    : { path: sourceRelative, size: sourceInfo.size, mtimeMs: diskMtimeMs };

  const manifest = {
    version: 1,
    ref: options.ref,
    displayName: options.displayName,
    architecture: options.architecture,
    memoryMiB: options.memoryMiB,
    vgaMemoryMiB: options.vgaMiB,
    license: options.license,
    provenance: options.provenance,
    source,
    disk: {
      fileName: options.servedName,
      format,
      url: diskUrl,
      size: sourceInfo.size,
      mtimeMs: diskMtimeMs,
      ...(sha256 === undefined ? {} : { sha256 }),
    },
    engine: engineFromLock(lock),
    boot: { mode: 'disk-boot', url: diskUrl, async: true, size: sourceInfo.size },
    notes: options.notes,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    join(outputDir, 'provenance.txt'),
    [
      `ref            : ${options.ref}`,
      // Chemin relatif au dépôt uniquement : jamais de chemin absolu publié.
      `source         : ${sourceRelative ?? '(disque externe — chemin non enregistré)'}`,
      `taille         : ${sourceInfo.size} octets (${(sourceInfo.size / GIB).toFixed(3)} Gio)`,
      `mtime (ms)     : ${diskMtimeMs}`,
      `format         : ${format}`,
      `sha256         : ${sha256 ?? '(non calculé — voir méthode)'}`,
      `généré le      : ${new Date().toISOString()}`,
      `outil          : scripts/prepare-windows7-asset.mjs`,
      '',
      'Média local non distribué : ne jamais committer ni copier dans public/.',
      '',
    ].join('\n'),
    'utf8',
  );

  log(`✓ Manifeste écrit : ${manifestPath}`);
  if (sha256) log(`  sha256=${sha256}`);
  log(`  taille=${sourceInfo.size} octets (${(sourceInfo.size / GIB).toFixed(3)} Gio)`);
  log(`  disque servi sous ${diskUrl}`);

  if (flags.json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

function makeProgress(total) {
  let nextMark = GIB;
  return (read) => {
    if (read >= nextMark || read === total) {
      const percent = total > 0 ? ((read / total) * 100).toFixed(1) : '?';
      log(`  ${(read / GIB).toFixed(2)} Gio / ${(total / GIB).toFixed(2)} Gio (${percent} %)`);
      nextMark += GIB;
    }
  };
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  });
