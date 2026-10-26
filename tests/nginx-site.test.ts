import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Nginx configuration guardrail (P2 security).
 *
 * Checks that the production configuration honors the invariants:
 * - `/downloads/` is strictly static, without an SPA fallback (a 404 is a real 404);
 * - the download manifest is JSON, not HTML;
 * - WASM is served with the right MIME type;
 * - `/images/` only serves files, with no SPA fallback and no index;
 * - proprietary system media are explicitly refused.
 *
 * Blocks are extracted by brace matching (`location` blocks may contain nested
 * blocks such as `types { ... }`).
 */

const repoRoot = process.cwd();
const siteConf = readFileSync(join(repoRoot, 'infra', 'nginx', 'site.conf'), 'utf8');

/** Extracts the body of the first block whose header contains `header`. */
function extractBlock(config: string, header: string): string {
  const start = config.indexOf(header);
  if (start === -1) throw new Error(`Block not found: ${header}`);
  const open = config.indexOf('{', start);
  if (open === -1) throw new Error(`Opening brace not found for: ${header}`);
  let depth = 0;
  for (let index = open; index < config.length; index += 1) {
    const char = config[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return config.slice(open + 1, index);
    }
  }
  throw new Error(`Closing brace not found for: ${header}`);
}

describe('nginx site.conf', () => {
  it('serves /downloads/ as strict static, without an SPA fallback', () => {
    const downloads = extractBlock(siteConf, 'location /downloads/');
    expect(downloads).toContain('try_files $uri =404;');
    expect(downloads).not.toContain('index.html');
    // Resumption of interrupted downloads (Range) without compression.
    expect(downloads).toContain('Accept-Ranges');
    expect(downloads).toContain('gzip off;');
  });

  it('exposes /downloads/manifest.json as JSON (never HTML)', () => {
    const manifest = extractBlock(siteConf, 'location = /downloads/manifest.json');
    expect(manifest).toContain('application/json');
    expect(manifest).toContain('try_files $uri =404;');
    expect(manifest).not.toContain('index.html');
  });

  it('serves WASM with the application/wasm MIME type', () => {
    const v86 = extractBlock(siteConf, 'location /v86/');
    expect(v86).toMatch(/application\/wasm\s+wasm;/);
    expect(v86).toContain('try_files $uri =404;');
    expect(v86).not.toContain('index.html');
  });

  it('serves /images/ without an SPA fallback or automatic index', () => {
    const images = extractBlock(siteConf, 'location /images/');
    expect(images).toContain('try_files $uri =404;');
    expect(images).toContain('autoindex off;');
    expect(images).not.toContain('index.html');
  });

  it('explicitly refuses proprietary system media under /images/', () => {
    expect(siteConf).toMatch(/location\s+~\*\s+"\^\/images\/.*windows/);
    expect(siteConf).toMatch(/return 404;/);
  });
});
