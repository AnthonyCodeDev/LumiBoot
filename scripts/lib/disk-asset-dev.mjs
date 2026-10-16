// Middleware de développement (connect/Vite) servant, sur la MÊME origine que
// l'app, le manifeste d'un disque RAW local et le disque lui-même par HTTP
// Range (206). Objectif : v86 (`hda.async = true`) lit le disque par plages
// sans jamais charger les 16 Gio en mémoire, sans copie dans `public/` (donc
// sans entrer dans le bundle Vite) et sans l'exposer publiquement.
//
// Le fichier source vit hors de `public/` (`images/<ref>/disk.img`, ignoré par
// Git). En production, ce middleware n'existe pas : le disque local n'est pas
// servi (voir docs/windows-7.md).
//
// Réutilise le serveur Range testé de `range-server.mjs` : mêmes garanties
// 206 / Content-Range / Accept-Ranges / CORS / OPTIONS.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createJsonHandler, createRangeHandler } from './range-server.mjs';

/** Remonte l'arborescence pour trouver la racine du dépôt (manifeste de disque). */
function findRepoRoot(start) {
  let dir = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'images', 'windows-7-x86', 'manifest.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Construit un middleware connect servant le disque local décrit par le
 * manifeste. Retourne un passe-plat (`next()`) si le manifeste ou le disque
 * n'est pas disponible : le développement des autres systèmes n'est pas cassé.
 *
 * @param {{ cwd?: string, repoRoot?: string, manifestPath?: string, diskPath?: string, logger?: (message: string) => void }} [options]
 */
export function createDiskAssetMiddleware(options = {}) {
  const logger = options.logger ?? ((message) => process.stderr.write(`${message}\n`));
  const passThrough = (_req, _res, next) => next();

  const repoRoot = options.repoRoot ?? findRepoRoot(options.cwd ?? process.cwd());
  if (repoRoot === null) {
    logger('[lumiboot] disque Windows 7 : dossier « images/windows-7-x86 » introuvable.');
    return passThrough;
  }

  const manifestPath =
    options.manifestPath ?? join(repoRoot, 'images', 'windows-7-x86', 'manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    logger(`[lumiboot] disque Windows 7 : manifeste illisible (${manifestPath}).`);
    return passThrough;
  }

  const ref = manifest?.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    logger('[lumiboot] disque Windows 7 : manifeste sans « ref ».');
    return passThrough;
  }

  // Le disque est cherché d'abord sous `images/<ref>/disk.img` (emplacement de
  // la codebase), puis au chemin source documenté par le manifeste.
  const servedName = manifest?.disk?.fileName ?? 'disk.img';
  const candidates = [
    options.diskPath,
    join(repoRoot, 'images', ref, servedName),
    manifest?.source?.path,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  let diskPath = null;
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (existsSync(absolute) && statSync(absolute).isFile()) {
      diskPath = absolute;
      break;
    }
  }
  if (diskPath === null) {
    logger(
      `[lumiboot] disque Windows 7 absent : copiez-le sous images/${ref}/${servedName} ` +
        '(voir docs/windows-7.md) pour lancer la session.',
    );
    return passThrough;
  }

  const info = statSync(diskPath);
  if (manifest?.disk?.size !== info.size) {
    logger(
      `[lumiboot] disque Windows 7 de taille incohérente : ${info.size} octets sur disque, ` +
        `${manifest?.disk?.size} dans le manifeste. Régénérez le manifeste.`,
    );
    return passThrough;
  }

  const diskRoute = `/images/${ref}/${servedName}`;
  const manifestRoute = `/images/${ref}/manifest.json`;

  const diskHandler = createRangeHandler({
    filePath: diskPath,
    size: info.size,
    contentType: 'application/octet-stream',
    token: null,
  });
  const manifestHandler = createJsonHandler({
    body: `${JSON.stringify(manifest, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    token: null,
  });

  logger(`[lumiboot] disque Windows 7 servi en HTTP Range : ${diskPath} (${info.size} octets).`);

  return function diskAssetMiddleware(req, res, next) {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (pathname === diskRoute) {
      diskHandler(req, res);
      return;
    }
    if (pathname === manifestRoute) {
      manifestHandler(req, res);
      return;
    }
    next();
  };
}
