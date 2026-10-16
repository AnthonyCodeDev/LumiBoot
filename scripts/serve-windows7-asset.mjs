#!/usr/bin/env node
// Sert LOCALEMENT (loopback) le disque d'un manifeste `prepare-*-asset` en
// HTTP Range, ainsi que le manifeste et les binaires du moteur v86, sur une
// seule origine. Objectif : v86 (`hda.async = true`) lit le disque par plages
// sans jamais télécharger les 16 Gio, sans copie dans public/ et sans exposer
// l'image publiquement.
//
//   node scripts/serve-windows7-asset.mjs
//   node scripts/serve-windows7-asset.mjs --manifest images/windows-7-x86/manifest.json --port 37893
//   node scripts/serve-windows7-asset.mjs --no-token     # loopback seulement
//
// SÉCURITÉ : par défaut le serveur n'écoute que sur 127.0.0.1 et exige un jeton
// (`?token=…` ou en-tête `X-Lumiboot-Token`). Ce n'est PAS un serveur public :
// aucun contrôle de licence n'est possible côté HTTP, l'image serait
// téléchargeable par quiconque peut joindre le port. `--expose` (host non
// loopback) exige un consentement explicite et n'est jamais recommandé.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssetServer } from './lib/range-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
const options = {
  manifest: join(repoRoot, 'images', 'windows-7-x86', 'manifest.json'),
  source: undefined,
  host: '127.0.0.1',
  port: 37893,
  token: undefined,
  noToken: false,
  expose: false,
};

for (let i = 0; i < args.length; i += 1) {
  const [name, inline] = args[i].startsWith('--') && args[i].includes('=')
    ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)]
    : [args[i], undefined];
  const value = () => {
    if (inline !== undefined) return inline;
    i += 1;
    if (i >= args.length) throw new Error(`Option ${name} sans valeur.`);
    return args[i];
  };
  switch (name) {
    case '--manifest': options.manifest = value(); break;
    case '--source': options.source = value(); break;
    case '--host': options.host = value(); break;
    case '--port': options.port = Number(value()); break;
    case '--token': options.token = value(); break;
    case '--no-token': options.noToken = true; break;
    case '--expose': options.expose = true; break;
    case '--help': case '-h':
      process.stdout.write(
        'Usage : node scripts/serve-windows7-asset.mjs [--manifest <json>] [--source <img>]\n' +
          '       [--host 127.0.0.1] [--port 37893] [--token <jeton> | --no-token] [--expose]\n',
      );
      process.exit(0);
      break;
    default:
      throw new Error(`Option inconnue : ${name}`);
  }
}

const isLoopback = (host) =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

async function main() {
  const manifestPath = resolve(options.manifest);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `Manifeste illisible : ${manifestPath}.\n` +
        `Générez-le d'abord : node scripts/prepare-windows7-asset.mjs`,
    );
  }
  const ref = manifest.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('Manifeste sans « ref » : impossible de construire les routes.');
  }

  const diskPath = resolve(options.source ?? manifest.source?.path ?? '');
  if (!existsSync(diskPath)) {
    throw new Error(`Disque introuvable : ${diskPath} (attend ${manifest.disk?.size} octets).`);
  }
  const diskInfo = await stat(diskPath);
  if (!diskInfo.isFile()) throw new Error(`Le disque n'est pas un fichier : ${diskPath}`);
  if (manifest.disk?.size !== diskInfo.size) {
    throw new Error(
      `Taille du disque incohérente : ${diskInfo.size} octets sur disque, ` +
        `${manifest.disk?.size} dans le manifeste. Régénérez le manifeste.`,
    );
  }

  if (!isLoopback(options.host) && !options.expose) {
    throw new Error(
      `Refus d'écouter sur « ${options.host} » (non-loopback). ` +
        `L'image serait exposée publiquement sans contrôle de licence. ` +
        `Ajoutez --expose en connaissance de cause (déconseillé).`,
    );
  }

  const token = options.noToken
    ? null
    : options.token ?? randomBytes(24).toString('hex');
  const suffix = token === null ? '' : `?token=${token}`;

  const diskRoute = `/images/${ref}/${manifest.disk.fileName ?? 'disk.img'}`;
  const manifestRoute = `/images/${ref}/manifest.json`;

  // Copie servie du manifeste : les URL portent le jeton pour que v86 puisse
  // lire le disque (et les binaires) sans configuration supplémentaire.
  const servedManifest = structuredClone(manifest);
  servedManifest.disk.url = `${diskRoute}${suffix}`;
  servedManifest.boot = { ...servedManifest.boot, url: `${diskRoute}${suffix}` };
  for (const binary of [servedManifest.engine?.wasm, servedManifest.engine?.bios?.seabios, servedManifest.engine?.bios?.vgabios]) {
    if (binary?.url) binary.url = `${binary.url}${suffix}`;
  }

  const routes = {
    [diskRoute]: { file: diskPath, contentType: 'application/octet-stream' },
    [manifestRoute]: { json: servedManifest, contentType: 'application/json; charset=utf-8' },
  };

  // Binaires du moteur v86 servis sur la même origine, s'ils ont été préparés.
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
  const hostForUrl = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host;
  const origin = `http://${hostForUrl}:${actualPort}`;

  process.stdout.write(
    [
      'LumiBoot — serveur local d’asset disque (HTTP Range)',
      `  origine   : ${origin}`,
      `  ref       : ${ref}`,
      `  disque    : ${diskPath} (${diskInfo.size} octets)`,
      token === null
        ? '  jeton     : désactivé (--no-token) — loopback uniquement'
        : `  jeton     : ${token}`,
      '',
      '  Preuve Range :',
      `    curl -sI -H "Range: bytes=0-0" "${origin}${diskRoute}${suffix}"`,
      '',
      '  Manifeste servi :',
      `    ${origin}${manifestRoute}${suffix}`,
      '',
      '  Arrêt : Ctrl+C',
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

main().catch((error) => {
  process.stderr.write(`✗ ${error.message}\n`);
  process.exitCode = 1;
});
