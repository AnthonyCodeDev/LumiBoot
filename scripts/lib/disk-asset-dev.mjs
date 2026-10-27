// Development middleware serving the manifests of local RAW disks and the disks
// themselves over HTTP Range, from the same origin as the app.
//
// Every `images/*/manifest.json` with `boot.mode === 'disk-boot'` is registered;
// the disk is served in place and never enters the `public/` bundle.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createJsonHandler, createRangeHandler } from './range-server.mjs';

const REF_PATTERN = /^[a-z0-9-]+$/;

/** Human-readable size in GiB. */
function formatGiB(bytes) {
  const gib = bytes / 1024 ** 3;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`;
}

/**
 * Serializes the public form of a disk manifest: `source` and `provenance` must
 * never leave the host.
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

/** Whether `dir` holds a subdirectory with a `manifest.json`. */
function hasDiskManifest(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'manifest.json')),
    );
  } catch {
    return false;
  }
}

/** Walks up from `start` looking for the repository root. */
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
 * Discovers every local disk under `images/`; `source.path` is relative to the
 * repository root, never to the cwd.
 */
function discoverLocalDisks(imagesDir) {
  const routes = new Map();
  const served = [];
  const skipped = [];
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
    // Only handle LOCAL disk manifests; published image manifests stay served by Vite.
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

/** Builds a connect middleware; passes through when no disk is available. */
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
