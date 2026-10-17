import { describe, expect, it } from 'vitest';
import { getDeclaredReadiness, getSystemById, systems } from './systems';

/**
 * La disponibilité du catalogue est une readiness DÉCLARÉE : elle ne présume
 * jamais que le média est réellement servable au runtime. `getDeclaredReadiness`
 * rend cette séparation explicite et expose la source média à vérifier.
 */
describe('getDeclaredReadiness — séparation déclaré / runtime', () => {
  it('un système bundled validé est déclaré ready, média « bundled-image »', () => {
    const debian = getSystemById('debian-12-i386')!;
    expect(getDeclaredReadiness(debian)).toEqual({
      availability: 'ready',
      mediaSource: 'bundled-image',
    });
  });

  it('Windows 7 (disque local) est déclaré ready mais média « local-disk » à vérifier au runtime', () => {
    const windows = getSystemById('windows-7-pro-sp1-x86')!;
    expect(getDeclaredReadiness(windows)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
    // Le disque local reste référencé : la vérification runtime saura quoi sonder.
    expect(windows.imageRef).toBeDefined();
  });

  it('un système user-import sans média reste « resource-required » et média « user-import »', () => {
    const windows = getSystemById('windows-10-x64')!;
    expect(getDeclaredReadiness(windows)).toEqual({
      availability: 'resource-required',
      mediaSource: 'user-import',
    });
  });

  it('tout média « local-disk » déclaré référence bien une image', () => {
    for (const system of systems) {
      const declared = getDeclaredReadiness(system);
      if (declared.mediaSource === 'local-disk') {
        expect(system.imageRef, `${system.id} doit référencer un disque local`).toBeDefined();
      }
    }
  });
});

/**
 * Windows 10 x86 réutilise le pipeline disque RAW local de Windows 7 sous v86.
 * Le pipeline étant validé comme Windows 7, la disponibilité dérivée passe à
 * `ready` : `validated` reflète un démarrage réel, sans maquillage.
 */
describe('Windows 10 x86 — pipeline disque local sous v86', () => {
  it('expose le disque local RAW installé et le média « bundled » par défaut', () => {
    const system = getSystemById('windows-10-x86')!;
    expect(system.architecture).toBe('i386');
    expect(system.imageRef).toBe('windows-10-x86');
    expect(system.mediaStrategy).toBe('bundled');
    expect(getDeclaredReadiness(system)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
  });

  it('utilise v86, virtio + ACPI, 2048 Mio et le démarrage disque', () => {
    const profile = getSystemById('windows-10-x86')!.launchProfiles[0]!;
    expect(profile.engineId).toBe('v86');
    expect(profile.executionMode).toBe('browser');
    expect(profile.hardwareProfile?.network).toBe('virtio');
    expect(profile.hardwareProfile?.acpi).toBe(true);
    expect(profile.configuration?.memoryMiB).toBe(2048);
    expect(profile.minMemoryMiB).toBe(2048);
    expect(profile.configuration?.bootDevice).toBe('disk');
    expect(profile.readiness?.mode).toBe('disk-boot');
    expect(profile.readiness?.marker).toBe('LUMIBOOT_DISK_BOOT:windows-10-x86');
  });

  it('est `ready` : pipeline disque local validé', () => {
    const system = getSystemById('windows-10-x86')!;
    expect(system.availability).toBe('ready');
  });
});
