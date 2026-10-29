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
const windows10Mother = getSystemById('windows-10-x86')!;
const ubuntuMother = getSystemById('ubuntu-18-i386')!;
const ubuntuDesktop = getSystemById('ubuntu-18-i386-desktop')!;
const ubuntuXfce = getSystemById('ubuntu-18-i386-xfce')!;
const macosSequoia = getSystemById('macos-sequoia')!;

describe('Debian variant group', () => {
  it('sorts the best variant first (XFCE → X11 → CLI)', () => {
    const group = getVariantGroup(debianMother);
    expect(group).toHaveLength(3);
    expect(group.map((system) => system.id)).toEqual([
      'debian-12-i386-xfce',
      'debian-12-i386-desktop',
      'debian-12-i386',
    ]);
  });

  it('finds the same group from any member', () => {
    const expected = ['debian-12-i386-xfce', 'debian-12-i386-desktop', 'debian-12-i386'];
    expect(getVariantGroup(debianDesktop).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(debianXfce).map((system) => system.id)).toEqual(expected);
  });

  it('finds the same parent from any child', () => {
    expect(getVariantParent(debianDesktop).id).toBe('debian-12-i386');
    expect(getVariantParent(debianXfce).id).toBe('debian-12-i386');
    expect(getVariantParent(debianMother).id).toBe('debian-12-i386');
  });

  it('exposes the effective parent id and the variant label', () => {
    expect(getVariantParentId(debianDesktop)).toBe('debian-12-i386');
    expect(getVariantParentId(debianMother)).toBe('debian-12-i386');
    expect(debianMother.variantGroupId).toBeUndefined();
    expect(debianMother.variantName).toBe('CLI');
    expect(debianDesktop.variantName).toBe('X11');
    expect(debianXfce.variantName).toBe('XFCE');
  });

  it('exposes an ascending variantOrder (XFCE < X11 < CLI)', () => {
    expect(debianXfce.variantOrder).toBe(1);
    expect(debianDesktop.variantOrder).toBe(2);
    expect(debianMother.variantOrder).toBe(3);
  });

  it('always resolves a child variant by its id and slug', () => {
    expect(getSystemById('debian-12-i386-xfce')).not.toBeNull();
    expect(getSystemById('debian-12-i386-xfce')?.id).toBe('debian-12-i386-xfce');
  });
});

describe('Ubuntu variant group', () => {
  it('sorts the best variant first (XFCE → X11 → CLI)', () => {
    const group = getVariantGroup(ubuntuMother);
    expect(group).toHaveLength(3);
    expect(group.map((system) => system.id)).toEqual([
      'ubuntu-18-i386-xfce',
      'ubuntu-18-i386-desktop',
      'ubuntu-18-i386',
    ]);
  });

  it('finds the same group from any member', () => {
    const expected = ['ubuntu-18-i386-xfce', 'ubuntu-18-i386-desktop', 'ubuntu-18-i386'];
    expect(getVariantGroup(ubuntuDesktop).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(ubuntuXfce).map((system) => system.id)).toEqual(expected);
  });

  it('finds the same parent from any child', () => {
    expect(getVariantParent(ubuntuDesktop).id).toBe('ubuntu-18-i386');
    expect(getVariantParent(ubuntuXfce).id).toBe('ubuntu-18-i386');
    expect(getVariantParent(ubuntuMother).id).toBe('ubuntu-18-i386');
  });

  it('exposes the effective parent id and the variant label', () => {
    expect(getVariantParentId(ubuntuDesktop)).toBe('ubuntu-18-i386');
    expect(getVariantParentId(ubuntuXfce)).toBe('ubuntu-18-i386');
    expect(getVariantParentId(ubuntuMother)).toBe('ubuntu-18-i386');
    expect(ubuntuMother.variantGroupId).toBeUndefined();
    expect(ubuntuMother.variantName).toBe('CLI');
    expect(ubuntuDesktop.variantName).toBe('X11');
    expect(ubuntuXfce.variantName).toBe('XFCE');
  });

  it('exposes an ascending variantOrder (XFCE < X11 < CLI)', () => {
    expect(ubuntuXfce.variantOrder).toBe(1);
    expect(ubuntuDesktop.variantOrder).toBe(2);
    expect(ubuntuMother.variantOrder).toBe(3);
  });

  it('always resolves a child variant by its id', () => {
    expect(getSystemById('ubuntu-18-i386-desktop')?.id).toBe('ubuntu-18-i386-desktop');
    expect(getSystemById('ubuntu-18-i386-xfce')?.id).toBe('ubuntu-18-i386-xfce');
  });

  it('selects XFCE as the default variant of the group', () => {
    expect(getDefaultVariant(ubuntuMother).id).toBe('ubuntu-18-i386-xfce');
    expect(getDefaultVariant(ubuntuDesktop).id).toBe('ubuntu-18-i386-xfce');
    expect(getDefaultVariant(ubuntuXfce).id).toBe('ubuntu-18-i386-xfce');
  });
});

describe('Windows 7 variant group', () => {
  it('sorts the default variant first (Professional → Lite)', () => {
    const group = getVariantGroup(windowsMother);
    expect(group).toHaveLength(2);
    expect(group.map((system) => system.id)).toEqual(['windows-7-pro-sp1-x86', 'windows-7-x86']);
  });

  it('finds the same group from the parent as from the child', () => {
    const expected = ['windows-7-pro-sp1-x86', 'windows-7-x86'];
    expect(getVariantGroup(windowsPro).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(windowsMother).map((system) => system.id)).toEqual(expected);
  });

  it('finds the Lite parent from the Professional child', () => {
    expect(getVariantParent(windowsPro).id).toBe('windows-7-x86');
    expect(getVariantParent(windowsMother).id).toBe('windows-7-x86');
    expect(getVariantParentId(windowsPro)).toBe('windows-7-x86');
    expect(getVariantParentId(windowsMother)).toBe('windows-7-x86');
  });

  it('exposes the neutral parent (Lite) and the child label', () => {
    expect(windowsMother.variantGroupId).toBeUndefined();
    expect(windowsMother.variantName).toBe('Lite');
    expect(windowsPro.variantGroupId).toBe('windows-7-x86');
    expect(windowsPro.variantName).toBe('Professional');
  });

  it('exposes an ascending variantOrder (Professional < Lite)', () => {
    expect(windowsPro.variantOrder).toBe(1);
    expect(windowsMother.variantOrder).toBe(2);
  });

  it('displays the parent under a neutral name and the child as best variant', () => {
    expect(windowsMother.displayName).toBe('Windows 7');
    expect(windowsPro.displayName).toBe('Windows 7 (Professional)');
    expect(getDefaultVariant(windowsMother).id).toBe('windows-7-pro-sp1-x86');
    expect(getDefaultVariant(windowsPro).id).toBe('windows-7-pro-sp1-x86');
  });
});

describe('standalone Windows 10 x86 system', () => {
  it('belongs to no variant group', () => {
    expect(windows10Mother.variantGroupId).toBeUndefined();
    expect(windows10Mother.variantName).toBeUndefined();
    expect(windows10Mother.variantOrder).toBeUndefined();
    expect(getVariantGroup(windows10Mother).map((system) => system.id)).toEqual(['windows-10-x86']);
    expect(getDefaultVariant(windows10Mother).id).toBe('windows-10-x86');
  });
});

describe('getDefaultVariant', () => {
  it('returns the best variant of the Debian group (from the parent as from a child)', () => {
    expect(getDefaultVariant(debianMother).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianDesktop).id).toBe('debian-12-i386-xfce');
    expect(getDefaultVariant(debianXfce).id).toBe('debian-12-i386-xfce');
  });

  it('returns the system itself when it is standalone', () => {
    expect(getDefaultVariant(windows10Mother).id).toBe('windows-10-x86');
  });
});

describe('getDisplaySystems', () => {
  it('excludes all child variants', () => {
    const display = getDisplaySystems();
    expect(display.every((system) => system.variantGroupId === undefined)).toBe(true);
    expect(display.some((system) => system.id === 'debian-12-i386-desktop')).toBe(false);
    expect(display.some((system) => system.id === 'debian-12-i386-xfce')).toBe(false);
    expect(display.some((system) => system.id === 'windows-7-pro-sp1-x86')).toBe(false);
    expect(display.some((system) => system.id === 'ubuntu-18-i386-desktop')).toBe(false);
    expect(display.some((system) => system.id === 'ubuntu-18-i386-xfce')).toBe(false);
  });

  it('keeps the Debian parent, the Windows 7 parent and the standalone systems', () => {
    const ids = getDisplaySystems().map((system) => system.id);
    expect(ids).toContain('debian-12-i386');
    expect(ids).toContain('windows-7-x86');
    expect(ids).not.toContain('windows-7-pro-sp1-x86');
    expect(ids).toContain('windows-10-x86');
    expect(ids).toContain('ubuntu-18-i386');
    expect(ids).not.toContain('ubuntu-18-i386-desktop');
    expect(ids).not.toContain('ubuntu-18-i386-xfce');
    expect(ids).toContain('macos-sequoia');
    expect(getDisplaySystems()).toHaveLength(systems.length - 5);
  });
});

describe('hasVariants', () => {
  it('is true for Debian (parent as well as child)', () => {
    expect(hasVariants(debianMother)).toBe(true);
    expect(hasVariants(debianDesktop)).toBe(true);
  });

  it('is true for Windows 7 (parent as well as child)', () => {
    expect(hasVariants(windowsMother)).toBe(true);
    expect(hasVariants(windowsPro)).toBe(true);
  });

  it('is false for Windows 10 x86 (standalone system)', () => {
    expect(hasVariants(windows10Mother)).toBe(false);
  });

  it('is true for Ubuntu 18.04 (parent as well as children)', () => {
    expect(hasVariants(ubuntuMother)).toBe(true);
    expect(hasVariants(ubuntuDesktop)).toBe(true);
    expect(hasVariants(ubuntuXfce)).toBe(true);
  });

  it('is false for a standalone system', () => {
    expect(hasVariants(macosSequoia)).toBe(false);
  });
});
