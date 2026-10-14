import { describe, expect, it } from 'vitest';
import { systems } from './systems';
import { validateCatalog } from './validation';
import { CatalogValidationError } from './errors';

function cloneCatalog(): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(systems)) as Array<Record<string, unknown>>;
}

describe('validateCatalog', () => {
  it('accepte le catalogue fourni', () => {
    expect(() => validateCatalog(cloneCatalog())).not.toThrow();
  });

  it('rejette une entrée sans identifiant', () => {
    const catalog = cloneCatalog();
    delete catalog[0]!.id;
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejette un accentRgb mal formé', () => {
    const catalog = cloneCatalog();
    catalog[0]!.accentRgb = 'not-a-color';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejette un slug invalide', () => {
    const catalog = cloneCatalog();
    catalog[0]!.slug = 'Debian 12';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejette les identifiants dupliqués', () => {
    const catalog = cloneCatalog();
    catalog[1]!.id = catalog[0]!.id;
    try {
      validateCatalog(catalog);
      throw new Error('devrait lever');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogValidationError);
      expect((error as CatalogValidationError).issues[0]?.message).toContain('dupliqué');
    }
  });
});
