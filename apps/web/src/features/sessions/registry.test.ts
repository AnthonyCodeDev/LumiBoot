import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { getSystemById } from '@lumiboot/catalog';
import { V86Provider } from '@lumiboot/provider-v86';
import { V86_LAZY_CAPABILITIES, createRegistry, explainSystemCompatibility } from './registry';

/** Guards the local copy of the capabilities against the real provider. */
describe('front-end registry — capabilities aligned with the real provider', () => {
  it('the lazy v86 engine advertises exactly the real V86Provider capabilities', () => {
    const lazy = createRegistry().engines.find((engine) => engine.id === 'v86');
    expect(lazy).toBeDefined();
    expect(lazy?.capabilities()).toEqual(new V86Provider().capabilities());
  });

  it('never advertises a RAM/disk snapshot not exposed by VMInstance', () => {
    const capabilities = createRegistry().engines[0]!.capabilities();
    expect(capabilities.ramSnapshots).toBe(false);
    expect(capabilities.diskSnapshots).toBe(false);
    // v86 does read the disk over HTTP Range.
    expect(capabilities.partialDownload).toBe(true);
    expect(V86_LAZY_CAPABILITIES.ramSnapshots).toBe(false);
    expect(V86_LAZY_CAPABILITIES.diskSnapshots).toBe(false);
  });
});

describe('explainSystemCompatibility — source of truth for the launch button', () => {
  it('accepts an i386 system with the integrated v86 engine', () => {
    const debian = getSystemById('debian-12-i386');
    expect(debian).not.toBeNull();
    expect(explainSystemCompatibility(debian!)).toEqual({ compatible: true, reasons: [] });
  });

  it('refuses an architecture v86 does not serve (x86_64)', () => {
    const debian = getSystemById('debian-12-i386')!;
    const wrongArch: OSDefinition = {
      ...debian,
      id: 'debian-x64',
      slug: 'debian-x64',
      architecture: 'x86_64',
    };

    const result = explainSystemCompatibility(wrongArch);
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/x86_64/);
  });
});
