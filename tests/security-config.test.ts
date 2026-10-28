import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Web configuration guardrails for P2 security:
 * - production sourcemaps are disabled by default;
 * - the pairing bearer is only persisted in `sessionStorage`;
 * - no WISP URL, which carries the token in the query, is ever logged.
 */

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
