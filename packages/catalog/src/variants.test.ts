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
const windows7 = getSystemById('windows-7-x86')!;

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

describe('getDefaultVariant', () => {
  it('renvoie la meilleure variante du groupe Debian (la mère comme un enfant)', () => {
    expect(getDefaultVariant(debianMother).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianDesktop).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianXfce).id).toBe('debian-12-i386-xfce');
  });

  it('renvoie le système lui-même quand il est autonome', () => {
    expect(getDefaultVariant(windows7).id).toBe('windows-7-x86');
  });
});

describe('getDisplaySystems', () => {
  it('exclut tous les variants enfants', () => {
    const display = getDisplaySystems();
    expect(display.every((system) => system.variantGroupId === undefined)).toBe(true);
    expect(display.some((system) => system.id === 'debian-12-i386-desktop')).toBe(false);
    expect(display.some((system) => system.id === 'debian-12-i386-xfce')).toBe(false);
  });

  it('conserve la mère Debian et les systèmes autonomes', () => {
    const ids = getDisplaySystems().map((system) => system.id);
    expect(ids).toContain('debian-12-i386');
    expect(ids).toContain('windows-7-x86');
    expect(ids).toContain('ubuntu-18-i386');
    expect(ids).toContain('macos-sequoia');
    expect(getDisplaySystems()).toHaveLength(systems.length - 2);
  });
});

describe('hasVariants', () => {
  it('est vrai pour Debian (mère comme enfant) et faux pour Windows 7', () => {
    expect(hasVariants(debianMother)).toBe(true);
    expect(hasVariants(debianDesktop)).toBe(true);
    expect(hasVariants(windows7)).toBe(false);
  });
});
