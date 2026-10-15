import { describe, expect, it } from 'vitest';
import {
  getAggregatedAvailability,
  getEffectiveAvailability,
  type SystemAvailabilityFacts,
} from './availability';
import { getSystemById, systems } from './systems';
import { isEngineIntegrated } from './engines';
import { launchProfiles } from './profiles';

const allFacts: SystemAvailabilityFacts = {
  hasImage: true,
  hasCompatibleProfile: true,
  engineIntegrated: true,
  validated: true,
};

describe('getEffectiveAvailability', () => {
  it('marque ready uniquement lorsque les quatre conditions sont réunies', () => {
    expect(getEffectiveAvailability(allFacts)).toBe('ready');
  });

  it('ne rend pas disponible un système sans image', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false })).toBe('planned');
  });

  it('ne rend pas disponible un système avec image mais moteur non intégré', () => {
    expect(getEffectiveAvailability({ ...allFacts, engineIntegrated: false })).toBe('planned');
  });

  it('ne rend pas disponible un système sans profil compatible', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasCompatibleProfile: false })).toBe('planned');
  });

  it('ne rend pas disponible un système non validé', () => {
    expect(getEffectiveAvailability({ ...allFacts, validated: false })).toBe('planned');
  });

  it('rétrograde un ready déclaré mais non prouvé', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false, declared: 'ready' })).toBe(
      'planned',
    );
  });
});

describe('getAggregatedAvailability (audit #19)', () => {
  it('ready si un MÊME candidat réunit les quatre conditions', () => {
    expect(getAggregatedAvailability([allFacts])).toBe('ready');
  });

  it('ne mélange pas validation d’un profil et moteur d’un autre', () => {
    // Candidat A : validé mais moteur non intégré.
    // Candidat B : moteur intégré mais non validé.
    // Des `some()` indépendants produiraient un faux `ready`.
    const candidates: SystemAvailabilityFacts[] = [
      { ...allFacts, engineIntegrated: false, validated: true },
      { ...allFacts, engineIntegrated: true, validated: false },
    ];
    expect(getAggregatedAvailability(candidates)).toBe('planned');
  });

  it('ready dès qu’un candidat cohérent coche tout, même en présence d’autres partiels', () => {
    const candidates: SystemAvailabilityFacts[] = [
      { ...allFacts, engineIntegrated: false },
      { ...allFacts },
    ];
    expect(getAggregatedAvailability(candidates)).toBe('ready');
  });

  it('sans candidat : planned', () => {
    expect(getAggregatedAvailability([])).toBe('planned');
  });
});

describe('catalogue : disponibilité effective cohérente', () => {
  it('marque Debian ready (image + moteur v86 intégré + boot validé)', () => {
    const debian = getSystemById('debian-12-i386');
    const profile = debian?.launchProfiles[0];
    expect(debian?.imageRef).toBeDefined();
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    expect(debian?.availability).toBe('ready');
  });

  it('garde les autres systèmes à planned', () => {
    expect(getSystemById('ubuntu-18-i386')?.availability).toBe('planned');
    expect(getSystemById('fedora-workstation')?.availability).toBe('planned');
    expect(getSystemById('macos-sequoia')?.availability).toBe('planned');
  });

  it('ne rend pas disponible un système dont le moteur n’est pas intégré', () => {
    const fedora = getSystemById('fedora-workstation');
    const profile = fedora?.launchProfiles[0];
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(false);
    expect(fedora?.availability).not.toBe('ready');
  });

  it('ne rend pas disponible un système sans image référencée', () => {
    const ubuntu = getSystemById('ubuntu-18-i386');
    expect(ubuntu?.imageRef).toBeUndefined();
    expect(ubuntu?.availability).not.toBe('ready');
  });
});

describe('catalogue : profils matériels et preuves de démarrage', () => {
  it('chaque profil porte un matériel et un marqueur explicites', () => {
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        expect(profile.hardwareProfile?.network).toBeDefined();
        // L'OS opérationnel prouve son démarrage par LUMIBOOT_GUEST_READY ; une
        // session graphique exige en plus LUMIBOOT_DESKTOP_READY (jamais simulé).
        expect(profile.readiness?.marker).toMatch(/^LUMIBOOT_(GUEST|DESKTOP)_READY:/);
      }
    }
  });

  it('respecte les choix matériels documentés', () => {
    expect(getSystemById('debian-12-i386')?.launchProfiles[0]?.hardwareProfile?.network).toBe(
      'virtio',
    );
    expect(getSystemById('ubuntu-18-i386')?.launchProfiles[0]?.hardwareProfile?.network).toBe(
      'virtio',
    );
    expect(getSystemById('windows-7-x86')?.launchProfiles[0]?.hardwareProfile?.network).toBe(
      'ne2k',
    );
  });

  it('conserve le marqueur Debian historique', () => {
    expect(getSystemById('debian-12-i386')?.launchProfiles[0]?.readiness?.marker).toBe(
      'LUMIBOOT_GUEST_READY:debian-12-i386',
    );
  });
});

describe('catalogue : flavor Debian Desktop (image publiée + boot validé)', () => {
  it('expose le profil graphique avec son marqueur Desktop dédié', () => {
    const desktop = getSystemById('debian-12-i386-desktop');
    const profile = desktop?.launchProfiles[0];
    expect(profile?.engineId).toBe('v86');
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop');
    expect(profile?.hardwareProfile?.network).toBe('virtio');
  });

  it("devient disponible : image publiée (`imageRef`) + boot graphique réel validé", () => {
    const desktop = getSystemById('debian-12-i386-desktop');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386-desktop');
    // Image publiée et boot Xorg+Openbox prouvé (voir docs/debian-desktop.md).
    expect(desktop?.imageRef).toBe('debian-12-i386-desktop');
    expect(profile?.validated).toBe(true);
    expect(desktop?.availability).toBe('ready');
  });

  it('laisse le profil console Debian inchangé et ready', () => {
    const consoleSystem = getSystemById('debian-12-i386');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386');
    expect(consoleSystem?.imageRef).toBeDefined();
    expect(profile?.validated).toBe(true);
    expect(consoleSystem?.availability).toBe('ready');
  });
});
