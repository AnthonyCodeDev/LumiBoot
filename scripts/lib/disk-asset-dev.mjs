// Middleware de développement (connect/Vite) servant, sur la MÊME origine que
// l'app, les manifestes des disques RAW locaux et les disques eux-mêmes par
// HTTP Range (206). Objectif : v86 (`hda.async = true`) lit un disque par
// plages sans jamais charger les dizaines de Gio en mémoire, sans copie dans
// `public/` (donc sans entrer dans le bundle Vite) et sans l'exposer
// publiquement.
//
// Découverte MULTI-DISQUES (mutualisée Windows XP/Vista/7/8/10) : au démarrage,
// chaque sous-dossier de `images/` contenant un `manifest.json` de disque local
// (`boot.mode === 'disk-boot'`) est enregistré. Le disque vit hors de `public/`
// (soit `images/<ref>/<servedName>`, soit le `source.path` du manifeste, servi
// IN-PLACE) et est ignoré par Git. En production, ce middleware n'existe pas :
// aucun disque local n'est servi (voir docs/windows-7.md).
//
// Réutilise le serveur Range testé de `range-server.mjs` : mêmes garanties
// 206 / Content-Range / Accept-Ranges / CORS / OPTIONS.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createJsonHandler, createRangeHandler } from './range-server.mjs';

/** Référence valide (identique au schéma `LocalDiskManifest`). */
const REF_PATTERN = /^[a-z0-9-]+$/;

/** Taille lisible en Gio (ex. 42949672960 → « 40 Gio »). */
function formatGiB(bytes) {
  const gib = bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} Gio`;
}

/**
 * Sérialise la forme PUBLIQUE d'un manifeste disque, telle que servie par HTTP.
 *
 * `source` (chemin réel de la machine de l'opérateur) et `provenance` (interne)
 * ne doivent JAMAIS sortir du poste : on construit explicitement la sortie
 * autorisée, de sorte qu'aucun champ interne inconnu présent dans le fichier
 * privé ne puisse être diffusé. Le schéma public correspondant vit dans
 * `@lumiboot/vm-assets` (`localDiskPublicManifestSchema`).
 *
 * @param {Record<string, unknown>} manifest manifeste privé lu sur disque
 * @returns {Record<string, unknown>} manifeste public (sans source/provenance)
 */
export function toPublicDiskManifest(manifest) {
  const publicManifest = {
    version: manifest.version,
    ref: manifest.ref,
    displayName: manifest.displayName,
    architecture: manifest.architecture,
    memoryMiB: manifest.memoryMiB,
    license: manifest.license,
    disk: manifest.disk,
    engine: manifest.engine,
    boot: manifest.boot,
  };
  if (manifest.vgaMemoryMiB !== undefined) publicManifest.vgaMemoryMiB = manifest.vgaMemoryMiB;
  if (manifest.notes !== undefined) publicManifest.notes = manifest.notes;
  return publicManifest;
}

/** Vrai si `dir` contient au moins un sous-dossier portant un `manifest.json`. */
function hasDiskManifest(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'manifest.json')),
    );
  } catch {
    return false;
  }
}

/**
 * Remonte l'arborescence à la recherche de la racine du dépôt. Marqueurs
 * robustes : `pnpm-workspace.yaml`, ou un dossier `images/` contenant au moins
 * un manifeste de disque. Aucune référence n'est codée en dur.
 */
function findRepoRoot(start) {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (hasDiskManifest(join(dir, 'images'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Découvre tous les disques RAW locaux servables sous `images/`.
 *
 * Pour chaque sous-dossier dont le `manifest.json` décrit un disque local
 * (`boot.mode === 'disk-boot'`), résout le fichier disque (candidats
 * `images/<ref>/<servedName>` puis `manifest.source.path`) et construit les
 * routes Range + manifeste. Les dossiers ignorés (manifeste d'image publiée,
 * disque absent, taille incohérente…) sont documentés mais non bloquants.
 *
 * @returns {{ routes: Map<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void>, served: Array<{ref: string, diskPath: string, size: number, diskRoute: string}>, skipped: string[] }}
 */
function discoverLocalDisks(imagesDir) {
  const routes = new Map();
  const served = [];
  const skipped = [];

  let entries;
  try {
    entries = readdirSync(imagesDir, { withFileTypes: true });
  } catch {
    return { routes, served, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(imagesDir, entry.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      skipped.push(`${entry.name} (manifeste illisible)`);
      continue;
    }

    const ref = manifest?.ref;
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
      skipped.push(`${entry.name} (référence absente ou invalide)`);
      continue;
    }
    // Ne traiter QUE les manifestes de disque local. Les manifestes d'image
    // publiée (`files`, sans `disk`) restent servis par Vite/`public/`.
    if (manifest?.boot?.mode !== 'disk-boot' || typeof manifest?.disk?.size !== 'number') {
      skipped.push(`${ref} (manifeste d'image publiée, pas un disque local)`);
      continue;
    }

    const servedName = manifest?.disk?.fileName ?? 'disk.img';
    const candidates = [join(imagesDir, ref, servedName), manifest?.source?.path].filter(
      (candidate) => typeof candidate === 'string' && candidate.length > 0,
    );

    let diskPath = null;
    for (const candidate of candidates) {
      const absolute = resolve(candidate);
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        diskPath = absolute;
        break;
      }
    }
    if (diskPath === null) {
      skipped.push(`${ref} (disque introuvable : ${candidates.join(' | ')})`);
      continue;
    }

    const info = statSync(diskPath);
    if (manifest.disk.size !== info.size) {
      skipped.push(
        `${ref} (taille incohérente : ${info.size} octets sur disque, ` +
          `${manifest.disk.size} dans le manifeste)`,
      );
      continue;
    }

    const diskRoute = `/images/${ref}/${servedName}`;
    const manifestRoute = `/images/${ref}/manifest.json`;
    routes.set(
      diskRoute,
      createRangeHandler({
        filePath: diskPath,
        size: info.size,
        contentType: 'application/octet-stream',
        token: null,
      }),
    );
    routes.set(
      manifestRoute,
      createJsonHandler({
        body: `${JSON.stringify(toPublicDiskManifest(manifest), null, 2)}\n`,
        contentType: 'application/json; charset=utf-8',
        token: null,
      }),
    );
    served.push({ ref, diskPath, size: info.size, diskRoute });
  }

  return { routes, served, skipped };
}

/**
 * Construit un middleware connect servant tous les disques locaux découverts.
 * Retourne un passe-plat (`next()`) si aucun disque n'est disponible : le
 * développement des autres systèmes n'est pas cassé.
 *
 * @param {{ cwd?: string, repoRoot?: string, imagesDir?: string, logger?: (message: string) => void }} [options]
 */
export function createDiskAssetMiddleware(options = {}) {
  const logger = options.logger ?? ((message) => process.stderr.write(`${message}\n`));
  const passThrough = (_req, _res, next) => next();

  const repoRoot = options.repoRoot ?? findRepoRoot(options.cwd ?? process.cwd());
  const imagesDir = options.imagesDir ?? (repoRoot === null ? null : join(repoRoot, 'images'));

  if (imagesDir === null || !existsSync(imagesDir)) {
    logger('[lumiboot] aucun disque local servi (dossier « images/ » introuvable).');
    return passThrough;
  }

  const { routes, served, skipped } = discoverLocalDisks(imagesDir);

  if (served.length > 0) {
    const list = served.map((disk) => `${disk.ref} ${formatGiB(disk.size)}`).join(' · ');
    logger(`[lumiboot] disques locaux prêts (HTTP Range) : ${list}`);
  } else {
    logger('[lumiboot] aucun disque local servi (Windows indisponibles).');
  }
  // Détail des dossiers ignorés uniquement en mode debug explicite.
  if (process.env.LUMIBOOT_DISK_DEBUG === '1') {
    for (const reason of skipped) logger(`[lumiboot] disque ignoré : ${reason}`);
  }

  if (routes.size === 0) return passThrough;

  return function diskAssetMiddleware(req, res, next) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    const handler = routes.get(pathname);
    if (handler !== undefined) {
      handler(req, res);
      return;
    }
    next();
  };
}
