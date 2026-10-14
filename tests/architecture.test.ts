import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Vitest s'exécute depuis la racine du dépôt. */
const repoRoot = process.cwd();

/** Packages qui ne doivent dépendre d'aucun framework d'UI ni de `apps/web`. */
const ISOLATED_PACKAGES = [
  'packages/vm-core',
  'packages/provider-v86',
  'packages/vm-assets',
  'packages/vm-storage',
  'packages/catalog',
  'packages/contracts',
];

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'react', pattern: /from\s+['"]react(?:-dom)?(?:['"/])/ },
  { name: 'zustand', pattern: /from\s+['"]zustand/ },
  { name: 'apps/web', pattern: /from\s+['"][^'"]*apps\/web/ },
  { name: '@lumiboot/web', pattern: /@lumiboot\/web/ },
];

const VM_CORE_FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'HTMLElement', pattern: /\bHTMLElement\b/ },
  { name: 'document', pattern: /\bdocument\b/ },
  { name: 'window', pattern: /\bwindow\b/ },
  { name: 'localStorage', pattern: /\blocalStorage\b/ },
  { name: 'indexedDB', pattern: /\bindexedDB\b/ },
];

function collectSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

describe('isolation architecturale', () => {
  for (const pkg of ISOLATED_PACKAGES) {
    it(`${pkg} n'importe ni React, ni Zustand, ni le front-end`, () => {
      const files = collectSourceFiles(join(repoRoot, pkg, 'src'));
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(content)) violations.push(`${file} importe ${rule.name}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('packages/vm-core reste indépendant du DOM', () => {
    const files = collectSourceFiles(join(repoRoot, 'packages/vm-core', 'src')).filter(
      (file) => !file.endsWith('.test.ts'),
    );
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const rule of VM_CORE_FORBIDDEN) {
        if (rule.pattern.test(content)) violations.push(`${file} utilise ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
