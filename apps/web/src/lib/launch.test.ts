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

  it('autorise Windows 7 directement depuis le disque local, sans média importé', () => {
    expect(getLaunchReadiness(system('windows-7-x86'))).toEqual({ canLaunch: true });
  });
});
