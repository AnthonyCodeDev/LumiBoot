import { describe, expect, it } from 'vitest';
import { getSystemById } from '@lumiboot/catalog';
import { getLaunchReadiness } from './launch';

function system(id: string) {
  const found = getSystemById(id);
  if (!found) throw new Error(`système de test introuvable : ${id}`);
  return found;
}

describe('getLaunchReadiness', () => {
  it('autorise un système bundled ready avec moteur intégré', () => {
    expect(getLaunchReadiness(system('debian-12-i386'))).toEqual({ canLaunch: true });
  });

  it('refuse un système planned dont le moteur n’est pas intégré', () => {
    const readiness = getLaunchReadiness(system('fedora-workstation'));
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.reason).toMatch(/préparation|intégré/i);
  });

  it('refuse Windows 7 sans média importé et explique la ressource requise', () => {
    const readiness = getLaunchReadiness(system('windows-7-x86'));
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.reason).toMatch(/ressource requise/i);
  });

  it('autorise Windows 7 dès que le média légal est importé', () => {
    expect(getLaunchReadiness(system('windows-7-x86'), { userMediaReady: true })).toEqual({
      canLaunch: true,
    });
  });
});
