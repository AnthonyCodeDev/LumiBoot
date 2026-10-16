import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fou de configuration Nginx (P2 sécurité).
 *
 * Vérifie que la configuration de production respecte les invariants :
 * - `/downloads/` strictement statique, sans fallback SPA (un 404 est un vrai 404) ;
 * - le manifeste de téléchargement est bien du JSON et non du HTML ;
 * - le WASM est servi avec le bon type MIME ;
 * - `/images/` ne sert que des fichiers, sans fallback SPA ni index ;
 * - les médias système propriétaires sont explicitement refusés.
 *
 * Les blocs sont extraits par appariement d'accolades (les blocs `location`
 * peuvent contenir des blocs imbriqués comme `types { … }`).
 */

const repoRoot = process.cwd();
const siteConf = readFileSync(join(repoRoot, 'infra', 'nginx', 'site.conf'), 'utf8');

/** Extrait le corps du premier bloc dont l'en-tête contient `header`. */
function extractBlock(config: string, header: string): string {
  const start = config.indexOf(header);
  if (start === -1) throw new Error(`Bloc introuvable : ${header}`);
  const open = config.indexOf('{', start);
  if (open === -1) throw new Error(`Accolade ouvrante introuvable pour : ${header}`);
  let depth = 0;
  for (let index = open; index < config.length; index += 1) {
    const char = config[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(open + 1, index);
    }
  }
  throw new Error(`Accolade fermante introuvable pour : ${header}`);
}

describe('nginx site.conf', () => {
  it('sert /downloads/ en statique strict, sans fallback SPA', () => {
    const downloads = extractBlock(siteConf, 'location /downloads/');
    expect(downloads).toContain('try_files $uri =404;');
    expect(downloads).not.toContain('index.html');
    // Reprise des téléchargements interrompus (Range) sans compression.
    expect(downloads).toContain('Accept-Ranges');
    expect(downloads).toContain('gzip off;');
  });

  it('expose /downloads/manifest.json en JSON (jamais du HTML)', () => {
    const manifest = extractBlock(siteConf, 'location = /downloads/manifest.json');
    expect(manifest).toContain('application/json');
    expect(manifest).toContain('try_files $uri =404;');
    expect(manifest).not.toContain('index.html');
  });

  it('sert le WASM avec le type MIME application/wasm', () => {
    const v86 = extractBlock(siteConf, 'location /v86/');
    expect(v86).toMatch(/application\/wasm\s+wasm;/);
    expect(v86).toContain('try_files $uri =404;');
    expect(v86).not.toContain('index.html');
  });

  it('sert /images/ sans fallback SPA ni index automatique', () => {
    const images = extractBlock(siteConf, 'location /images/');
    expect(images).toContain('try_files $uri =404;');
    expect(images).toContain('autoindex off;');
    expect(images).not.toContain('index.html');
  });

  it('refuse explicitement les médias système propriétaires sous /images/', () => {
    expect(siteConf).toMatch(/location\s+~\*\s+"\^\/images\/.*windows/);
    expect(siteConf).toMatch(/return 404;/);
  });
});
