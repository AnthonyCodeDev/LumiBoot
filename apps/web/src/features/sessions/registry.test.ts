import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { getSystemById } from '@lumiboot/catalog';
import { V86Provider } from '@lumiboot/provider-v86';
import { V86_LAZY_CAPABILITIES, createRegistry, explainSystemCompatibility } from './registry';

/**
 * Le registre front-end charge `V86Provider` paresseusement : il ne peut donc
 * pas importer le provider pour lire ses capacités. Ces tests garantissent
 * l'ALIGNEMENT de la copie locale sur le provider RÉEL (source commune) et
 * l'absence de capacités non implémentées (snapshots RAM/disque).
 */
describe('registre front-end — capacités alignées sur le provider réel', () => {
  it('le moteur lazy v86 annonce exactement les capacités du V86Provider réel', () => {
    const lazy = createRegistry().engines.find((engine) => engine.id === 'v86');
    expect(lazy).toBeDefined();
    expect(lazy?.capabilities()).toEqual(new V86Provider().capabilities());
  });

  it('n’annonce jamais de snapshot RAM/disque non exposé par VMInstance', () => {
    const capabilities = createRegistry().engines[0]!.capabilities();
    expect(capabilities.ramSnapshots).toBe(false);
    expect(capabilities.diskSnapshots).toBe(false);
    // v86 lit bien le disque par HTTP Range.
    expect(capabilities.partialDownload).toBe(true);
    expect(V86_LAZY_CAPABILITIES.ramSnapshots).toBe(false);
    expect(V86_LAZY_CAPABILITIES.diskSnapshots).toBe(false);
  });
});

describe('explainSystemCompatibility — source de vérité du bouton de lancement', () => {
  it('accepte un système i386 avec le moteur v86 intégré', () => {
    const debian = getSystemById('debian-12-i386');
    expect(debian).not.toBeNull();
    expect(explainSystemCompatibility(debian!)).toEqual({ compatible: true, reasons: [] });
  });

  it('refuse une architecture non servie par v86 (x86_64)', () => {
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
