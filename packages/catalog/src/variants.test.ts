import { describe, expect, it } from 'vitest';
import {
  getDefaultVariant,
  getDisplaySystems,
  getSystemById,
  getVariantGroup,
  getVariantParent,
  getVariantParentId,
  hasVariants,
  systems,
} from './systems';

const debianMother = getSystemById('debian-12-i386')!;
const debianDesktop = getSystemById('debian-12-i386-desktop')!;
const debianXfce = getSystemById('debian-12-i386-xfce')!;
const windowsMother = getSystemById('windows-7-x86')!;
const windowsPro = getSystemById('windows-7-pro-sp1-x86')!;
// Groupe Windows 10 : la mère x86 (expérimentale) + le stub x64 (non intégré).
const windows10Mother = getSystemById('windows-10-x86')!;
const windows10X64 = getSystemById('windows-10-x64')!;
// Système réellement autonome (aucun groupe de variantes).
const ubuntu = getSystemById('ubuntu-18-i386')!;

describe('groupe de variantes Debian', () => {
  it('trie la meilleure variante en premier (XFCE → X11 → CLI)', () => {
    const group = getVariantGroup(debianMother);
    expect(group).toHaveLength(3);
    expect(group.map((system) => system.id)).toEqual([
      'debian-12-i386-xfce',
      'debian-12-i386-desktop',
      'debian-12-i386',
    ]);
  });

  it('retrouve le même groupe depuis n’importe quel membre', () => {
    const expected = ['debian-12-i386-xfce', 'debian-12-i386-desktop', 'debian-12-i386'];
    expect(getVariantGroup(debianDesktop).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(debianXfce).map((system) => system.id)).toEqual(expected);
  });

  it('retrouve la même mère depuis n’importe quel enfant', () => {
    expect(getVariantParent(debianDesktop).id).toBe('debian-12-i386');
    expect(getVariantParent(debianXfce).id).toBe('debian-12-i386');
    expect(getVariantParent(debianMother).id).toBe('debian-12-i386');
  });

  it('expose l’id de mère effective et le libellé de variant', () => {
    expect(getVariantParentId(debianDesktop)).toBe('debian-12-i386');
    expect(getVariantParentId(debianMother)).toBe('debian-12-i386');
    expect(debianMother.variantGroupId).toBeUndefined();
    expect(debianMother.variantName).toBe('CLI');
    expect(debianDesktop.variantName).toBe('X11');
    expect(debianXfce.variantName).toBe('XFCE');
  });

  it('expose un variantOrder croissant (XFCE < X11 < CLI)', () => {
    expect(debianXfce.variantOrder).toBe(1);
    expect(debianDesktop.variantOrder).toBe(2);
    expect(debianMother.variantOrder).toBe(3);
  });

  it('résout toujours un variant enfant par son id et son slug', () => {
    expect(getSystemById('debian-12-i386-xfce')).not.toBeNull();
    expect(getSystemById('debian-12-i386-xfce')?.id).toBe('debian-12-i386-xfce');
  });
});

describe('groupe de variantes Windows 7', () => {
  it('trie la variante par défaut en premier (Professionnel → Lite)', () => {
    const group = getVariantGroup(windowsMother);
    expect(group).toHaveLength(2);
    expect(group.map((system) => system.id)).toEqual(['windows-7-pro-sp1-x86', 'windows-7-x86']);
  });

  it('retrouve le même groupe depuis la mère comme depuis l’enfant', () => {
    const expected = ['windows-7-pro-sp1-x86', 'windows-7-x86'];
    expect(getVariantGroup(windowsPro).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(windowsMother).map((system) => system.id)).toEqual(expected);
  });

  it('retrouve la mère Lite depuis l’enfant Professionnel', () => {
    expect(getVariantParent(windowsPro).id).toBe('windows-7-x86');
    expect(getVariantParent(windowsMother).id).toBe('windows-7-x86');
    expect(getVariantParentId(windowsPro)).toBe('windows-7-x86');
    expect(getVariantParentId(windowsMother)).toBe('windows-7-x86');
  });

  it('expose la mère neutre (Lite) et le libellé de l’enfant', () => {
    // La mère porte le groupe (id neutre `windows-7-x86`) et pas de
    // `variantGroupId` ; l'enfant Professionnel y est rattaché.
    expect(windowsMother.variantGroupId).toBeUndefined();
    expect(windowsMother.variantName).toBe('Lite');
    expect(windowsPro.variantGroupId).toBe('windows-7-x86');
    expect(windowsPro.variantName).toBe('Professionnel');
  });

  it('expose un variantOrder croissant (Professionnel < Lite)', () => {
    expect(windowsPro.variantOrder).toBe(1);
    expect(windowsMother.variantOrder).toBe(2);
  });

  it('affiche la mère sous un nom neutre et l’enfant comme meilleure variante', () => {
    expect(windowsMother.displayName).toBe('Windows 7');
    expect(windowsPro.displayName).toBe('Windows 7 (Professionnel)');
    expect(getDefaultVariant(windowsMother).id).toBe('windows-7-pro-sp1-x86');
    expect(getDefaultVariant(windowsPro).id).toBe('windows-7-pro-sp1-x86');
  });
});

describe('groupe de variantes Windows 10', () => {
  it('trie la variante x86 (expérimentale) en premier, x64 en second', () => {
    const group = getVariantGroup(windows10Mother);
    expect(group).toHaveLength(2);
    expect(group.map((system) => system.id)).toEqual(['windows-10-x86', 'windows-10-x64']);
  });

  it('retrouve le même groupe depuis la mère comme depuis l’enfant x64', () => {
    const expected = ['windows-10-x86', 'windows-10-x64'];
    expect(getVariantGroup(windows10X64).map((system) => system.id)).toEqual(expected);
  });

  it('retrouve la mère x86 depuis l’enfant x64', () => {
    expect(getVariantParent(windows10X64).id).toBe('windows-10-x86');
    expect(getVariantParentId(windows10X64)).toBe('windows-10-x86');
    expect(getVariantParentId(windows10Mother)).toBe('windows-10-x86');
  });

  it('expose la mère neutre (32 bits) et le libellé du stub x64', () => {
    // La mère porte le groupe (id neutre `windows-10-x86`) sans `variantGroupId`.
    expect(windows10Mother.variantGroupId).toBeUndefined();
    expect(windows10Mother.variantName).toBe('32 bits (expérimental)');
    expect(windows10X64.variantGroupId).toBe('windows-10-x86');
    expect(windows10X64.variantName).toBe('64 bits (non intégré)');
  });

  it('expose un variantOrder croissant (x86 < x64) et x86 par défaut', () => {
    expect(windows10Mother.variantOrder).toBe(1);
    expect(windows10X64.variantOrder).toBe(2);
    expect(getDefaultVariant(windows10Mother).id).toBe('windows-10-x86');
    expect(getDefaultVariant(windows10X64).id).toBe('windows-10-x86');
  });

  it('ne perd pas le stub x64 (même id, même slug, reste non intégré)', () => {
    expect(windows10X64.id).toBe('windows-10-x64');
    expect(windows10X64.slug).toBe('windows-10-x64');
    expect(windows10X64.availability).toBe('resource-required');
  });
});

describe('getDefaultVariant', () => {
  it('renvoie la meilleure variante du groupe Debian (la mère comme un enfant)', () => {
    expect(getDefaultVariant(debianMother).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianDesktop).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianXfce).id).toBe('debian-12-i386-xfce');
  });

  it('renvoie le système lui-même quand il est autonome', () => {
    expect(getDefaultVariant(ubuntu).id).toBe('ubuntu-18-i386');
  });
});

describe('getDisplaySystems', () => {
  it('exclut tous les variants enfants', () => {
    const display = getDisplaySystems();
    expect(display.every((system) => system.variantGroupId === undefined)).toBe(true);
    expect(display.some((system) => system.id === 'debian-12-i386-desktop')).toBe(false);
    expect(display.some((system) => system.id === 'debian-12-i386-xfce')).toBe(false);
    expect(display.some((system) => system.id === 'windows-7-pro-sp1-x86')).toBe(false);
    expect(display.some((system) => system.id === 'windows-10-x64')).toBe(false);
  });

  it('conserve la mère Debian, la mère Windows 7 et les systèmes autonomes', () => {
    const ids = getDisplaySystems().map((system) => system.id);
    expect(ids).toContain('debian-12-i386');
    // La carte Windows 7 affichée est la MÈRE neutre, pas l'enfant Professionnel.
    expect(ids).toContain('windows-7-x86');
    expect(ids).not.toContain('windows-7-pro-sp1-x86');
    // La carte Windows 10 affichée est la MÈRE x86, pas le stub x64.
    expect(ids).toContain('windows-10-x86');
    expect(ids).not.toContain('windows-10-x64');
    expect(ids).toContain('ubuntu-18-i386');
    expect(ids).toContain('macos-sequoia');
    // 4 enfants repliés (2 Debian + 1 Windows 7 + 1 Windows 10).
    expect(getDisplaySystems()).toHaveLength(systems.length - 4);
  });
});

describe('hasVariants', () => {
  it('est vrai pour Debian (mère comme enfant)', () => {
    expect(hasVariants(debianMother)).toBe(true);
    expect(hasVariants(debianDesktop)).toBe(true);
  });

  it('est vrai pour Windows 7 (mère comme enfant)', () => {
    expect(hasVariants(windowsMother)).toBe(true);
    expect(hasVariants(windowsPro)).toBe(true);
  });

  it('est vrai pour Windows 10 (mère x86 comme stub x64)', () => {
    expect(hasVariants(windows10Mother)).toBe(true);
    expect(hasVariants(windows10X64)).toBe(true);
  });

  it('est faux pour un système autonome', () => {
    expect(hasVariants(ubuntu)).toBe(false);
  });
});
