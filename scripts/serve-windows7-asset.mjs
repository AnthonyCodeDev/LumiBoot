#!/usr/bin/env node
// Sert LOCALEMENT (loopback) le disque d'un manifeste `prepare-*-asset` en
// HTTP Range, ainsi que le manifeste et les binaires du moteur v86, sur une
// seule origine. Objectif : v86 (`hda.async = true`) lit le disque par plages
// sans jamais télécharger les 32 Gio, sans copie dans public/ et sans exposer
// l'image publiquement.
//
//   node scripts/serve-windows7-asset.mjs
//   node scripts/serve-windows7-asset.mjs --manifest images/windows-7-pro-sp1-x86/manifest.json --port 37893
//   node scripts/serve-windows7-asset.mjs --no-token     # loopback seulement
//
// SÉCURITÉ : par défaut le serveur n'écoute que sur 127.0.0.1 et exige un jeton
// (`?token=…` ou en-tête `X-Lumiboot-Token`). Ce n'est PAS un serveur public :
// aucun contrôle de licence n'est possible côté HTTP, l'image serait
// téléchargeable par quiconque peut joindre le port. `--expose` (host non
// loopback) exige un consentement explicite et n'est jamais recommandé.
//
// Le manifeste diffusé est la forme PUBLIQUE du manifeste disque : `source`
// (chemin réel de la machine) et `provenance` (interne) ne sont JAMAIS servis.

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
 * Analyse les arguments de la ligne de commande. Extrait dans une fonction pour
 * que l'import du module (tests) n'exécute NI parsing NI serveur.
 */
export function parseArgs(args) {
  const options = { ...DEFAULTS };

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

  return options;
}

const isLoopback = (host) =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

/**
 * Construit la forme PUBLIQUE du manifeste servi : retire `source` et
 * `provenance` (internes), puis applique le jeton (`suffix`) aux URL du disque
 * et des binaires du moteur pour que v86 puisse lire sans configuration.
 *
 * On construit explicitement la sortie autorisée : aucun champ interne inconnu
 * du manifeste privé ne peut être diffusé par accident.
 *
 * @param {Record<string, any>} manifest manifeste privé lu sur disque
 * @param {{ suffix?: string }} [options] suffixe d'URL (`?token=…` ou vide)
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
 * Résout le disque à servir : `--source` (cwd), sinon le chemin enregistré dans
 * le manifeste — RELATIF à la racine du dépôt (jamais au cwd : Vite tourne dans
 * `apps/web`) —, sinon `images/<ref>/<fileName>` à la racine du dépôt. Un
 * manifeste issu d'un disque externe n'enregistre aucun chemin : `--source` est
 * alors obligatoire.
 *
 * @param {{ source?: string, manifest: Record<string, any> }} input
 * @returns {string} chemin absolu du disque
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
      'Ce manifeste vient d’un disque externe : aucun chemin local n’y est enregistré. ' +
        'Relancez avec --source "<disque>".',
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
      `Manifeste illisible : ${manifestPath}.\n` +
        `Générez-le d'abord : node scripts/prepare-windows7-asset.mjs`,
    );
  }
  const ref = manifest.ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('Manifeste sans « ref » : impossible de construire les routes.');
  }

  const diskPath = resolveDiskPath({ source: options.source, manifest });
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

  // Copie servie du manifeste : forme publique (sans source/provenance) et URL
  // portant le jeton pour que v86 lise le disque et les binaires sans config.
  const servedManifest = toPublicServedManifest(manifest, { suffix });

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

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  });
}
