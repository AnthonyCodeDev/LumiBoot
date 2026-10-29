import { describe, expect, it } from 'vitest';
import { systems } from './systems';
import { validateCatalog } from './validation';
import { CatalogValidationError } from './errors';

function cloneCatalog(): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(systems)) as Array<Record<string, unknown>>;
}

describe('validateCatalog', () => {
  it('accepts the provided catalog', () => {
    expect(() => validateCatalog(cloneCatalog())).not.toThrow();
  });

  it('rejects an entry without an identifier', () => {
    const catalog = cloneCatalog();
    delete catalog[0]!.id;
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejects a malformed accentRgb', () => {
    const catalog = cloneCatalog();
    catalog[0]!.accentRgb = 'not-a-color';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejects an invalid slug', () => {
    const catalog = cloneCatalog();
    catalog[0]!.slug = 'Debian 12';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('rejects duplicate identifiers', () => {
    const catalog = cloneCatalog();
    catalog[1]!.id = catalog[0]!.id;
    try {
      validateCatalog(catalog);
      throw new Error('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogValidationError);
      expect((error as CatalogValidationError).issues[0]?.message).toContain('duplicate');
    }
  });

  it('rejects a variant pointing to a nonexistent group', () => {
    const catalog = cloneCatalog();
    const child = catalog.find((entry) => entry.id === 'windows-7-pro-sp1-x86')!;
    child.variantGroupId = 'windows-7-inexistant';
    expect(() => validateCatalog(catalog)).toThrow(CatalogValidationError);
  });

  it('accepts the Windows 7 group: parent without group, attached variant', () => {
    const catalog = cloneCatalog();
    const mother = catalog.find((entry) => entry.id === 'windows-7-x86')!;
    const child = catalog.find((entry) => entry.id === 'windows-7-pro-sp1-x86')!;
    expect(mother.variantGroupId).toBeUndefined();
    expect(child.variantGroupId).toBe('windows-7-x86');
    expect(() => validateCatalog(catalog)).not.toThrow();
  });
});
