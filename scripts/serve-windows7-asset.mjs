#!/usr/bin/env node
// Serves LOCALLY (loopback) the disk of a `prepare-*-asset` manifest over HTTP
// Range, together with the manifest and the v86 engine binaries, from a single
// origin. Goal: v86 (`hda.async = true`) reads the disk in ranges without ever
// downloading the whole 32 GiB, with no copy into public/ and without exposing
// the image publicly.
//
//   node scripts/serve-windows7-asset.mjs
//   node scripts/serve-windows7-asset.mjs --manifest images/windows-7-pro-sp1-x86/manifest.json --port 37893
//   node scripts/serve-windows7-asset.mjs --no-token     # loopback only
//
// SECURITY: by default the server only listens on 127.0.0.1 and requires a token
// (`?token=…` or the `X-Lumiboot-Token` header). This is NOT a public server: no
// license check is possible at the HTTP level, so the image would be
// downloadable by anyone able to reach the port. `--expose` (a non-loopback
// host) requires explicit consent and is never recommended.
//
// The broadcast manifest is the PUBLIC form of the disk manifest: `source` (real
// path of the machine) and `provenance` (internal) are NEVER served.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssetServer } from './lib/range-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const DEFAULTS = {
  manifest: join(repoRoot, 'images', 'windows-7-pro-sp1-x86', 'manifest.json'),
  source: undefined,
  host: '127.0.0.1',
  port: 37893,
  token: undefined,
  noToken: false,
  expose: false,
};

/**
 * Parses the command-line arguments. Extracted into a function so importing the
 * module (tests) runs neither the parsing nor the server.
 */
export function parseArgs(args) {
  const options = { ...DEFAULTS };

  for (let i = 0; i < args.length; i += 1) {
    const [name, inline] =
      args[i].startsWith('--') && args[i].includes('=')
        ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)]
        : [args[i], undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= args.length) throw new Error(`Option ${name} requires a value.`);
      return args[i];
    };
    switch (name) {
      case '--manifest':
        options.manifest = value();
        break;
      case '--source':
        options.source = value();
        break;
      case '--host':
        options.host = value();
        break;
      case '--port':
        options.port = Number(value());
        break;
      case '--token':
        options.token = value();
        break;
      case '--no-token':
        options.noToken = true;
        break;
      case '--expose':
        options.expose = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          'Usage: node scripts/serve-windows7-asset.mjs [--manifest <json>] [--source <img>]\n' +
            '       [--host 127.0.0.1] [--port 37893] [--token <token> | --no-token] [--expose]\n',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return options;
}

const isLoopback = (host) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

/**
 * Builds the PUBLIC form of the served manifest: drops `source` and
 * `provenance` (internal), then appends the token (`suffix`) to the disk and
 * engine binary URLs so v86 can read them without configuration.
 *
 * The allowed output is built explicitly: no unknown internal field of the
 * private manifest can leak by accident.
 *
 * @param {Record<string, any>} manifest private manifest read from disk
 * @param {{ suffix?: string }} [options] URL suffix (`?token=…` or empty)
 */
export function toPublicServedManifest(manifest, options = {}) {
  const suffix = options.suffix ?? '';
  const ref = manifest.ref;
  const diskUrl = `/images/${ref}/${manifest.disk?.fileName ?? 'disk.img'}${suffix}`;

  const engine = manifest.engine === undefined ? undefined : structuredClone(manifest.engine);
  if (engine !== undefined) {
    for (const binary of [engine.wasm, engine.bios?.seabios, engine.bios?.vgabios]) {
      if (binary?.url) binary.url = `${binary.url}${suffix}`;
    }
  }

  const publicManifest = {
    version: manifest.version,
    ref,
    displayName: manifest.displayName,
    architecture: manifest.architecture,
    memoryMiB: manifest.memoryMiB,
    license: manifest.license,
    disk: { ...manifest.disk, url: diskUrl },
    engine,
    boot: { ...manifest.boot, url: diskUrl },
  };
  if (manifest.vgaMemoryMiB !== undefined) publicManifest.vgaMemoryMiB = manifest.vgaMemoryMiB;
  if (manifest.notes !== undefined) publicManifest.notes = manifest.notes;
  return publicManifest;
}

/**
 * Resolves the disk to serve: `--source` (cwd), otherwise the path recorded in
 * the manifest — RELATIVE to the repository root (never the cwd: Vite runs in
 * `apps/web`) —, otherwise `images/<ref>/<fileName>` at the repository root. A
 * manifest created from an external disk records no path: `--source` is then
 * mandatory.
 *
 * @param {{ source?: string, manifest: Record<string, any> }} input
 * @returns {string} absolute path of the disk
 */
export function resolveDiskPath({ source, manifest }) {
  if (source !== undefined && source.length > 0) return resolve(source);
  const recorded = manifest.source?.path;
  if (typeof recorded === 'string' && recorded.length > 0) {
    return isAbsolute(recorded) ? recorded : resolve(repoRoot, recorded);
  }
  const fileName = manifest.disk?.fileName ?? 'disk.img';
  if (manifest.source?.external === true) {
    throw new Error(
      'This manifest comes from an external disk: no local path is recorded in it. ' +
        'Re-run with --source "<disk>".',
    );
  }
  return join(repoRoot, 'images', String(manifest.ref), fileName);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(options.manifest);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `Unreadable manifest: ${manifestPath}.\n` +
        `Generate it first: node scripts/prepare-windows7-asset.mjs`,
    );
  }
  const ref = manifest.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('Manifest without "ref": cannot build the routes.');
  }

  const diskPath = resolveDiskPath({ source: options.source, manifest });
  if (!existsSync(diskPath)) {
    throw new Error(`Disk not found: ${diskPath} (expected ${manifest.disk?.size} bytes).`);
  }
  const diskInfo = await stat(diskPath);
  if (!diskInfo.isFile()) throw new Error(`The disk is not a file: ${diskPath}`);
  if (manifest.disk?.size !== diskInfo.size) {
    throw new Error(
      `Inconsistent disk size: ${diskInfo.size} bytes on disk, ` +
        `${manifest.disk?.size} in the manifest. Regenerate the manifest.`,
    );
  }

  if (!isLoopback(options.host) && !options.expose) {
    throw new Error(
      `Refusing to listen on "${options.host}" (non-loopback). ` +
        `The image would be exposed publicly with no license check. ` +
        `Add --expose knowingly (not recommended).`,
    );
  }

  const token = options.noToken ? null : (options.token ?? randomBytes(24).toString('hex'));
  const suffix = token === null ? '' : `?token=${token}`;

  const diskRoute = `/images/${ref}/${manifest.disk.fileName ?? 'disk.img'}`;
  const manifestRoute = `/images/${ref}/manifest.json`;

  // Served copy of the manifest: public form (no source/provenance) with URLs
  // carrying the token so v86 reads the disk and binaries without config.
  const servedManifest = toPublicServedManifest(manifest, { suffix });

  const routes = {
    [diskRoute]: { file: diskPath, contentType: 'application/octet-stream' },
    [manifestRoute]: { json: servedManifest, contentType: 'application/json; charset=utf-8' },
  };

  // v86 engine binaries served from the same origin, when they have been prepared.
  const v86Dir = join(repoRoot, 'apps', 'web', 'public', 'v86');
  for (const [name, contentType] of [
    ['v86.wasm', 'application/wasm'],
    ['seabios.bin', 'application/octet-stream'],
    ['vgabios.bin', 'application/octet-stream'],
  ]) {
    const file = join(v86Dir, name);
    if (existsSync(file)) routes[`/v86/${name}`] = { file, contentType };
  }

  const server = createAssetServer({ routes, token });
  const address = await server.listen({ host: options.host, port: options.port });
  const actualPort = typeof address === 'object' && address !== null ? address.port : options.port;
  const hostForUrl =
    options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const origin = `http://${hostForUrl}:${actualPort}`;

  process.stdout.write(
    [
      'LumiBoot — local disk asset server (HTTP Range)',
      `  origin    : ${origin}`,
      `  ref       : ${ref}`,
      `  disk      : ${diskPath} (${diskInfo.size} bytes)`,
      token === null
        ? '  token     : disabled (--no-token) — loopback only'
        : `  token     : ${token}`,
      '',
      '  Range proof:',
      `    curl -sI -H "Range: bytes=0-0" "${origin}${diskRoute}${suffix}"`,
      '',
      '  Served manifest:',
      `    ${origin}${manifestRoute}${suffix}`,
      '',
      '  Stop: Ctrl+C',
      '',
    ].join('\n'),
  );

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  });
}
