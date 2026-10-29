import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, proxyConnectSrc } from '../scripts/render-nginx-config.mjs';

// Nginx guardrail: strict static paths, JSON manifest, WASM MIME, no proprietary media.

const repoRoot = process.cwd();
const siteConf = readFileSync(join(repoRoot, 'infra', 'nginx', 'site.conf'), 'utf8');
const securityHeaders = readFileSync(
  join(repoRoot, 'infra', 'nginx', 'security-headers.conf'),
  'utf8',
);

/** The twelve local proxy origins the policy must allow (`wss:` checked apart). */
const PROXY_ORIGINS = proxyConnectSrc(DEFAULTS.proxyPort)
  .split(' ')
  .filter((source) => source !== 'wss:');

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
    // Resumption of interrupted downloads over Range, without compression.
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

  it('refuses versioned Windows media written as win7, win-7, win_10 or win 8', () => {
    // The owner regex must cover `win[0-9]` and its separated spellings.
    expect(siteConf).toMatch(/win\[-_ \]\?\[0-9\]/);
    const ownerRegex = /location ~\* "([^"]+)"/.exec(siteConf);
    expect(ownerRegex).not.toBeNull();
    const pattern = new RegExp(ownerRegex![1]!, 'i');
    for (const path of [
      '/images/windows-7-x86/disk.img',
      '/images/winxp/disk.img',
      '/images/winvista/disk.img',
      '/images/win7/disk.img',
      '/images/win-7/disk.img',
      '/images/win_10/disk.img',
      '/images/win 8/disk.img',
    ]) {
      expect(pattern.test(path), path).toBe(true);
    }
    // Free systems must keep working.
    for (const path of ['/images/debian-12/disk.img', '/images/ubuntu-18-i386/disk.img']) {
      expect(pattern.test(path), path).toBe(false);
    }
  });

  it('hides the nginx version', () => {
    expect(siteConf).toMatch(/server_tokens\s+off;/);
  });

  it('serves index.html uncached, including through the SPA fallback', () => {
    const index = extractBlock(siteConf, 'location = /index.html');
    expect(index).toContain('Cache-Control "no-cache"');
    expect(index).not.toMatch(/max-age/);
  });
});

describe('nginx security-headers.conf', () => {
  function csp(config: string): string {
    const match = /add_header Content-Security-Policy "([^"]+)"/.exec(config);
    if (match === null) throw new Error('Content-Security-Policy not found');
    return match[1]!;
  }

  it('blocks base tags and form redirections', () => {
    const policy = csp(securityHeaders);
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  it('allows every local proxy variant over HTTP(S) and WS(S)', () => {
    const policy = csp(securityHeaders);
    expect(PROXY_ORIGINS).toHaveLength(12);
    for (const source of PROXY_ORIGINS) {
      expect(policy, source).toContain(source);
    }
    // `user-relay` mode: the relay host is user-supplied, so `wss:` alone is allowed.
    expect(policy).toMatch(/connect-src[^;]*\bwss:\s*(;|$)/);
    // Never a wildcard.
    expect(policy).not.toMatch(/connect-src[^;]*\*/);
  });
});
