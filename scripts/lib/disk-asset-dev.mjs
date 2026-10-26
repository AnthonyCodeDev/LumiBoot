// Development middleware (connect/Vite) serving, from the SAME origin as the
// app, the manifests of local RAW disks and the disks themselves over HTTP Range
// (206). Goal: v86 (`hda.async = true`) reads a disk in ranges without ever
// loading tens of GiB into memory, without a copy into `public/` (so it never
// enters the Vite bundle) and without exposing it publicly.
//
// MULTI-DISK discovery (shared by Windows XP/Vista/7/8/10): at startup, every
// subdirectory of `images/` holding a local disk `manifest.json`
// (`boot.mode === 'disk-boot'`) is registered. The disk lives outside `public/`
// (either `images/<ref>/<servedName>` or the manifest `source.path`, served IN
// PLACE) and is ignored by Git. In production this middleware does not exist: no
// local disk is served (see docs/windows-7.md).
//
// Reuses the tested Range server from `range-server.mjs`: same guarantees for
// 206 / Content-Range / Accept-Ranges / CORS / OPTIONS.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createJsonHandler, createRangeHandler } from './range-server.mjs';

/** Valid reference (same as the `LocalDiskManifest` schema). */
const REF_PATTERN = /^[a-z0-9-]+$/;

/** Human-readable size in GiB (e.g. 42949672960 → "40 GiB"). */
function formatGiB(bytes) {
  const gib = bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

/**
 * Serializes the PUBLIC form of a disk manifest, as served over HTTP.
 *
 * `source` (real path of the operator's machine) and `provenance` (internal)
 * must NEVER leave the host: the allowed output is built explicitly, so that no
 * unknown internal field present in the private file can leak. The matching
 * public schema lives in `@lumiboot/vm-assets` (`localDiskPublicManifestSchema`).
 *
 * @param {Record<string, unknown>} manifest private manifest read from disk
 * @returns {Record<string, unknown>} public manifest (without source/provenance)
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

/** True when `dir` holds at least one subdirectory containing a `manifest.json`. */
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
 * Walks up the tree looking for the repository root. Robust markers:
 * `pnpm-workspace.yaml`, or an `images/` directory holding at least one disk
 * manifest. No path is hard-coded.
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
 * Discovers every servable local RAW disk under `images/`.
 *
 * For each subdirectory whose `manifest.json` describes a local disk
 * (`boot.mode === 'disk-boot'`), resolves the disk file (candidates
 * `images/<ref>/<servedName>` then `manifest.source.path`) and builds the Range
 * route plus the manifest route. Skipped directories (published image manifest,
 * missing disk, inconsistent size…) are reported but not blocking.
 *
 * `manifest.source.path` is RELATIVE to the repository root (the parent
 * directory of `images/`), not to the cwd: Vite starts from `apps/web`, so
 * `resolve()` alone would look in the wrong place and the disk would appear
 * missing. An absolute path inherited from an older manifest is accepted as is.
 *
 * @returns {{ routes: Map<string, (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void>, served: Array<{ref: string, diskPath: string, size: number, diskRoute: string}>, skipped: string[] }}
 */
function discoverLocalDisks(imagesDir) {
  const routes = new Map();
  const served = [];
  const skipped = [];
  // Repository root = parent directory of `images/` (no hard-coded path).
  const repoRoot = dirname(resolve(imagesDir));

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
      skipped.push(`${entry.name} (unreadable manifest)`);
      continue;
    }

    const ref = manifest?.ref;
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
      skipped.push(`${entry.name} (missing or invalid reference)`);
      continue;
    }
    // Only handle LOCAL disk manifests. Published image manifests (`files`, no
    // `disk`) keep being served by Vite/`public/`.
    if (manifest?.boot?.mode !== 'disk-boot' || typeof manifest?.disk?.size !== 'number') {
      skipped.push(`${ref} (published image manifest, not a local disk)`);
      continue;
    }

    const servedName = manifest?.disk?.fileName ?? 'disk.img';
    const candidates = [join(imagesDir, ref, servedName), manifest?.source?.path].filter(
      (candidate) => typeof candidate === 'string' && candidate.length > 0,
    );

    let diskPath = null;
    for (const candidate of candidates) {
      const absolute = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        diskPath = absolute;
        break;
      }
    }
    if (diskPath === null) {
      skipped.push(`${ref} (disk not found: ${candidates.join(' | ')})`);
      continue;
    }

    const info = statSync(diskPath);
    if (manifest.disk.size !== info.size) {
      skipped.push(
        `${ref} (inconsistent size: ${info.size} bytes on disk, ` +
          `${manifest.disk.size} in the manifest)`,
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
 * Builds a connect middleware serving every discovered local disk.
 * Returns a pass-through (`next()`) when no disk is available: development of
 * the other systems is not broken.
 *
 * @param {{ cwd?: string, repoRoot?: string, imagesDir?: string, logger?: (message: string) => void }} [options]
 */
export function createDiskAssetMiddleware(options = {}) {
  const logger = options.logger ?? ((message) => process.stderr.write(`${message}\n`));
  const passThrough = (_req, _res, next) => next();

  const repoRoot = options.repoRoot ?? findRepoRoot(options.cwd ?? process.cwd());
  const imagesDir = options.imagesDir ?? (repoRoot === null ? null : join(repoRoot, 'images'));

  if (imagesDir === null || !existsSync(imagesDir)) {
    logger('[lumiboot] no local disk served ("images/" directory not found).');
    return passThrough;
  }

  const { routes, served, skipped } = discoverLocalDisks(imagesDir);

  if (served.length > 0) {
    const list = served.map((disk) => `${disk.ref} ${formatGiB(disk.size)}`).join(' · ');
    logger(`[lumiboot] local disks ready (HTTP Range): ${list}`);
  } else {
    logger('[lumiboot] no local disk served (Windows unavailable).');
  }
  // Skipped directories are detailed only in explicit debug mode.
  if (process.env.LUMIBOOT_DISK_DEBUG === '1') {
    for (const reason of skipped) logger(`[lumiboot] disk skipped: ${reason}`);
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
