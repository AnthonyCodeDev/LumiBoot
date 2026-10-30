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
const fedoraMother = getSystemById('fedora-44-x86-64')!;
const fedoraXfce = getSystemById('fedora-44-x86-64-xfce')!;
const alpineMother = getSystemById('alpine-3-24-x86-64')!;
const alpineXfce = getSystemById('alpine-3-24-x86-64-xfce')!;
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

describe('Fedora variant group', () => {
  it('sorts the default variant first (XFCE → CLI)', () => {
    const group = getVariantGroup(fedoraMother);
    expect(group).toHaveLength(2);
    expect(group.map((system) => system.id)).toEqual(['fedora-44-x86-64-xfce', 'fedora-44-x86-64']);
  });

  it('finds the same group from the parent as from the child', () => {
    const expected = ['fedora-44-x86-64-xfce', 'fedora-44-x86-64'];
    expect(getVariantGroup(fedoraXfce).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(fedoraMother).map((system) => system.id)).toEqual(expected);
  });

  it('finds the CLI parent from the XFCE child', () => {
    expect(getVariantParent(fedoraXfce).id).toBe('fedora-44-x86-64');
    expect(getVariantParent(fedoraMother).id).toBe('fedora-44-x86-64');
    expect(getVariantParentId(fedoraXfce)).toBe('fedora-44-x86-64');
    expect(getVariantParentId(fedoraMother)).toBe('fedora-44-x86-64');
  });

  it('exposes the neutral parent (CLI) and the child label', () => {
    expect(fedoraMother.variantGroupId).toBeUndefined();
    expect(fedoraMother.variantName).toBe('CLI');
    expect(fedoraXfce.variantGroupId).toBe('fedora-44-x86-64');
    expect(fedoraXfce.variantName).toBe('XFCE');
  });

  it('exposes an ascending variantOrder (XFCE < CLI)', () => {
    expect(fedoraXfce.variantOrder).toBe(1);
    expect(fedoraMother.variantOrder).toBe(2);
  });

  it('selects XFCE as the default variant and exposes both variants as ready', () => {
    expect(getDefaultVariant(fedoraMother).id).toBe('fedora-44-x86-64-xfce');
    expect(getDefaultVariant(fedoraXfce).id).toBe('fedora-44-x86-64-xfce');
    // Both profiles are declared `validated: true`: the XFCE card is launchable.
    expect(fedoraMother.availability).toBe('ready');
    expect(fedoraXfce.availability).toBe('ready');
  });

  it('folds the XFCE child onto the CLI card and out of the displayed systems', () => {
    const display = getDisplaySystems().map((system) => system.id);
    expect(display).toContain('fedora-44-x86-64');
    expect(display).not.toContain('fedora-44-x86-64-xfce');
    expect(hasVariants(fedoraMother)).toBe(true);
    expect(hasVariants(fedoraXfce)).toBe(true);
  });

  it('always resolves the XFCE child by its id and slug', () => {
    expect(getSystemById('fedora-44-x86-64-xfce')?.slug).toBe('fedora-44-x86-64-xfce');
  });
});

describe('Alpine variant group', () => {
  it('sorts the default variant first (XFCE → CLI)', () => {
    const group = getVariantGroup(alpineMother);
    expect(group).toHaveLength(2);
    expect(group.map((system) => system.id)).toEqual([
      'alpine-3-24-x86-64-xfce',
      'alpine-3-24-x86-64',
    ]);
  });

  it('finds the same group from the parent as from the child', () => {
    const expected = ['alpine-3-24-x86-64-xfce', 'alpine-3-24-x86-64'];
    expect(getVariantGroup(alpineXfce).map((system) => system.id)).toEqual(expected);
    expect(getVariantGroup(alpineMother).map((system) => system.id)).toEqual(expected);
  });

  it('finds the CLI parent from the XFCE child', () => {
    expect(getVariantParent(alpineXfce).id).toBe('alpine-3-24-x86-64');
    expect(getVariantParent(alpineMother).id).toBe('alpine-3-24-x86-64');
    expect(getVariantParentId(alpineXfce)).toBe('alpine-3-24-x86-64');
    expect(getVariantParentId(alpineMother)).toBe('alpine-3-24-x86-64');
  });

  it('exposes the neutral parent (CLI) and the child label', () => {
    expect(alpineMother.variantGroupId).toBeUndefined();
    expect(alpineMother.variantName).toBe('CLI');
    expect(alpineXfce.variantGroupId).toBe('alpine-3-24-x86-64');
    expect(alpineXfce.variantName).toBe('XFCE');
  });

  it('exposes an ascending variantOrder (XFCE < CLI)', () => {
    expect(alpineXfce.variantOrder).toBe(1);
    expect(alpineMother.variantOrder).toBe(2);
  });

  it('selects XFCE as the default variant and exposes both variants as ready', () => {
    expect(getDefaultVariant(alpineMother).id).toBe('alpine-3-24-x86-64-xfce');
    expect(getDefaultVariant(alpineXfce).id).toBe('alpine-3-24-x86-64-xfce');
    // Both profiles are `validated: true`: the XFCE card is launchable, and the
    // 2026-10-30 real boot is recorded by desktop-alpine-xfce.spec.ts.
    expect(alpineMother.availability).toBe('ready');
    expect(alpineXfce.availability).toBe('ready');
  });

  it('folds the XFCE child onto the CLI card and out of the displayed systems', () => {
    const display = getDisplaySystems().map((system) => system.id);
    expect(display).toContain('alpine-3-24-x86-64');
    expect(display).not.toContain('alpine-3-24-x86-64-xfce');
    expect(hasVariants(alpineMother)).toBe(true);
    expect(hasVariants(alpineXfce)).toBe(true);
  });

  it('always resolves the XFCE child by its id and slug', () => {
    expect(getSystemById('alpine-3-24-x86-64-xfce')?.slug).toBe('alpine-3-24-x86-64-xfce');
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
    expect(display.some((system) => system.id === 'fedora-44-x86-64-xfce')).toBe(false);
    expect(display.some((system) => system.id === 'alpine-3-24-x86-64-xfce')).toBe(false);
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
    expect(ids).toContain('fedora-44-x86-64');
    expect(ids).not.toContain('fedora-44-x86-64-xfce');
    expect(ids).toContain('alpine-3-24-x86-64');
    expect(ids).not.toContain('alpine-3-24-x86-64-xfce');
    expect(ids).toContain('macos-sequoia');
    // Seven child variants are folded away: Debian X11/XFCE, Ubuntu X11/XFCE,
    // Windows 7 Professional, Fedora XFCE and Alpine XFCE.
    expect(getDisplaySystems()).toHaveLength(systems.length - 7);
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
