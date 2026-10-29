import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULTS, renderNginxConfigs } from '../scripts/render-nginx-config.mjs';

// infra/nginx/*.conf are rendered from *.template: the default render must match.

const repoRoot = process.cwd();

/** Tracked file content, with line endings normalised (`.gitattributes` pins LF). */
function tracked(name: string): string {
  return readFileSync(join(repoRoot, 'infra', 'nginx', name), 'utf8').replace(/\r\n/g, '\n');
}

function connectSources(securityHeaders: string): string[] {
  const policy = /add_header Content-Security-Policy "([^"]+)"/.exec(securityHeaders)?.[1];
  if (policy === undefined) throw new Error('Content-Security-Policy not found');
  const directive = /(?:^|;)\s*connect-src([^;]*)/.exec(policy)?.[1];
  if (directive === undefined) throw new Error('connect-src not found');
  return directive.trim().split(/\s+/);
}

describe('renderNginxConfigs', () => {
  it('reproduces the tracked files with the defaults and no .env', () => {
    // Explicit empty environment: the renderer must never read `.env`.
    const { siteConf, securityHeaders } = renderNginxConfigs({});
    expect(siteConf).toBe(tracked('site.conf'));
    expect(securityHeaders).toBe(tracked('security-headers.conf'));
  });

  it('leaves no placeholder behind', () => {
    const { siteConf, securityHeaders } = renderNginxConfigs({});
    expect(siteConf).not.toContain('${');
    expect(securityHeaders).not.toContain('${');
  });

  it('defaults to the historical values, with the normalised domain', () => {
    const { siteConf } = renderNginxConfigs({});
    expect(siteConf).toMatch(/^\s*listen 80;$/m);
    expect(siteConf).toMatch(/^\s*server_name lumiboot\.example\.com;$/m);
    expect(DEFAULTS.proxyPort).toBe(37892);
  });

  it('renders the twelve proxy origins in order plus the wss: catch-all', () => {
    const port = 40000;
    const expected = [
      ...['127.0.0.1', 'localhost', '[::1]'].flatMap((host) =>
        ['http', 'ws', 'https', 'wss'].map((scheme) => `${scheme}://${host}:${port}`),
      ),
      'wss:',
    ];
    const { securityHeaders } = renderNginxConfigs({ LUMIBOOT_PROXY_PORT: String(port) });
    expect(connectSources(securityHeaders)).toEqual(["'self'", ...expected]);
    // Nothing keeps pointing at the default port.
    expect(securityHeaders).not.toContain(':37892');
  });

  it('applies LUMIBOOT_DOMAIN and LUMIBOOT_HTTP_PORT', () => {
    const { siteConf } = renderNginxConfigs({
      LUMIBOOT_DOMAIN: 'example.org',
      LUMIBOOT_HTTP_PORT: '8080',
    });
    expect(siteConf).toMatch(/^\s*server_name example\.org;$/m);
    expect(siteConf).toMatch(/^\s*listen 8080;$/m);
    // Only those two lines move: the rest is still the tracked configuration.
    expect(siteConf).toBe(
      tracked('site.conf')
        .replace('listen 80;', 'listen 8080;')
        .replace('server_name lumiboot.example.com;', 'server_name example.org;'),
    );
  });

  it('treats a blank value as unset', () => {
    const { siteConf } = renderNginxConfigs({ LUMIBOOT_DOMAIN: '', LUMIBOOT_HTTP_PORT: '  ' });
    expect(siteConf).toBe(tracked('site.conf'));
  });

  it('refuses a domain that is not a bare host', () => {
    for (const domain of [
      'https://example.org',
      'example.org/path',
      'exa mple.org',
      'exa$mple.org',
    ]) {
      expect(() => renderNginxConfigs({ LUMIBOOT_DOMAIN: domain }), domain).toThrow(
        /LUMIBOOT_DOMAIN/,
      );
    }
  });

  it('refuses an out-of-range or non-numeric port', () => {
    for (const port of ['0', '65536', '80.5', 'http', '-1']) {
      expect(() => renderNginxConfigs({ LUMIBOOT_HTTP_PORT: port }), port).toThrow(
        /LUMIBOOT_HTTP_PORT/,
      );
      expect(() => renderNginxConfigs({ LUMIBOOT_PROXY_PORT: port }), port).toThrow(
        /LUMIBOOT_PROXY_PORT/,
      );
    }
  });
});
