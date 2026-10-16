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
