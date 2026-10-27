#!/usr/bin/env node
// Serves locally, on loopback, the disk of a prepare-*-asset manifest over HTTP
// Range, with the manifest and the v86 engine binaries from a single origin.
//
//   node scripts/serve-windows7-asset.mjs --manifest <json> [--source <img>]
//   node scripts/serve-windows7-asset.mjs --port 37893 [--token <t> | --no-token]
//
// SECURITY: listens on 127.0.0.1 and requires a token by default; `--expose`
// widens it to a non-loopback host. The served manifest drops `source` and
// `provenance`.

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

/** Parses the CLI arguments; importing the module never starts the server. */
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
            '       [--host 127.0.0.1] [--port 37893] [--token <token> | --no-token] [--expose] [-h]\n',
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

/** Drops `source` and `provenance`, and appends the token suffix to served URLs. */
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

/** Disk path from `--source`, the recorded path, or `images/<ref>/`; external disks need `--source`. */
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

  // Served manifest carries the token so v86 reads the disk without configuration.
  const servedManifest = toPublicServedManifest(manifest, { suffix });

  const routes = {
    [diskRoute]: { file: diskPath, contentType: 'application/octet-stream' },
    [manifestRoute]: { json: servedManifest, contentType: 'application/json; charset=utf-8' },
  };

  // v86 engine binaries, served from the same origin when prepared.
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
