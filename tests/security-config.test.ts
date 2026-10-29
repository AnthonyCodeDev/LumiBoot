import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Web config guardrails: sourcemaps off, bearer in sessionStorage, no token in logs.

const repoRoot = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(join(repoRoot, directory));
  return files;
}

describe('web configuration (security)', () => {
  it('keeps the Docker development server on loopback by default', () => {
    const compose = read('infra/dev/docker-compose.yml');
    // Host-side publication must be driven by WEB_DEV_HOST, not a literal wildcard.
    expect(compose).toContain("'${WEB_DEV_HOST:-127.0.0.1}:${WEB_DEV_PORT:-5173}");
    expect(compose).toContain('${WEB_DEV_PORT:-5173}:${WEB_DEV_PORT:-5173}');
    const ports = compose.slice(compose.indexOf('ports:'), compose.indexOf('environment:'));
    expect(ports).not.toMatch(/0\.0\.0\.0/);
    // Inside the container Vite must listen on every interface to be reachable.
    expect(compose).toContain('WEB_DEV_HOST: 0.0.0.0');
  });

  it('disables public sourcemaps by default (explicit opt-in)', () => {
    const config = read('apps/web/vite.config.ts');
    expect(config).not.toMatch(/sourcemap:\s*true/);
    expect(config).toContain('LUMIBOOT_SOURCEMAP');
    expect(config).toMatch(/productionSourcemap/);
  });

  it('only persists the pairing bearer in sessionStorage', () => {
    const persistence = read('apps/web/src/features/proxy/persistence.ts');
    expect(persistence).toContain('sessionStorage');
    expect(persistence).not.toContain('localStorage.setItem');
    expect(persistence).not.toContain('localStorage.getItem');
  });

  it('never logs a WISP/token URL in the front-end', () => {
    const files = [
      ...collectSourceFiles('apps/web/src'),
      ...collectSourceFiles('packages/vm-network/src'),
      ...collectSourceFiles('packages/provider-v86/src'),
    ];
    const suspicious =
      /console\.(?:log|info|debug|warn|error|trace)\s*\([^)]*(?:token|wisp|relay_url|proxyToken)/i;
    const offenders = files.filter((file) => suspicious.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
