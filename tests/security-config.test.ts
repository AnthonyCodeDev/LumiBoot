import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Garde-fous de configuration web (P2 sécurité) :
 * - sourcemaps de production désactivées par défaut ;
 * - le bearer d'appairage n'est persisté qu'en `sessionStorage` ;
 * - aucune URL WISP (qui porte le token en query) n'est journalisée.
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

describe('configuration web (sécurité)', () => {
  it('désactive les sourcemaps publiques par défaut (opt-in explicite)', () => {
    const config = read('apps/web/vite.config.ts');
    expect(config).not.toMatch(/sourcemap:\s*true/);
    expect(config).toContain('LUMIBOOT_SOURCEMAP');
    expect(config).toMatch(/productionSourcemap/);
  });

  it("ne persiste le bearer d'appairage que dans sessionStorage", () => {
    const persistence = read('apps/web/src/features/proxy/persistence.ts');
    expect(persistence).toContain('sessionStorage');
    expect(persistence).not.toContain('localStorage.setItem');
    expect(persistence).not.toContain('localStorage.getItem');
  });

  it('ne journalise jamais une URL WISP/token dans le front', () => {
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
