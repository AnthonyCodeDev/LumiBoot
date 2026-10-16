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

describe('getEffectiveAvailability : média utilisateur requis', () => {
  it('marque resource-required lorsque le média utilisateur manque', () => {
    expect(
      getEffectiveAvailability({
        ...allFacts,
        hasImage: false,
        validated: false,
        requiresUserMedia: true,
      }),
    ).toBe('resource-required');
  });

  it('ne masque pas un état unavailable déclaré', () => {
    expect(
      getEffectiveAvailability({
        ...allFacts,
        hasImage: false,
        validated: false,
        requiresUserMedia: true,
        declared: 'unavailable',
      }),
    ).toBe('unavailable');
  });

  it('reste ready si un candidat coche les quatre conditions', () => {
    expect(getAggregatedAvailability([{ ...allFacts, requiresUserMedia: true }])).toBe('ready');
  });

  it('resource-required prime sur planned dans l’agrégation', () => {
    expect(
      getAggregatedAvailability([
        { ...allFacts, hasImage: false, validated: false },
        { ...allFacts, hasImage: false, validated: false, requiresUserMedia: true },
      ]),
    ).toBe('resource-required');
  });
});

describe('catalogue : Windows 7 sous v86 (disque RAW local)', () => {
  it('est sélectionnable, moteur v86 intégré, et ready (boot disque prouvé)', () => {
    const windows = getSystemById('windows-7-x86');
    const profile = windows?.launchProfiles[0];
    const definition = launchProfiles.find((candidate) => candidate.id === 'windows-7-x86');
    expect(windows).not.toBeNull();
    expect(windows?.family).toBe('windows');
    expect(windows?.architecture).toBe('i386');
    expect(profile?.engineId).toBe('v86');
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    // `validated` vit sur la définition du catalogue, pas sur le contrat.
    expect(definition?.validated).toBe(true);
    expect(windows?.availability).toBe('ready');
  });

  it('référence le disque RAW local de la codebase (plus de média à importer)', () => {
    expect(getSystemById('windows-7-x86')?.availability).toBe('ready');
    // Le disque local est référencé : plus de `resource-required`.
    expect(getSystemById('windows-7-x86')?.imageRef).toBe('windows-7-x86');
    expect(getSystemById('windows-7-x86')?.mediaStrategy).toBe('bundled');
  });

  it('utilise une preuve de démarrage disque (aucun marqueur invité simulé)', () => {
    const profile = getSystemById('windows-7-x86')?.launchProfiles[0];
    expect(profile?.readiness?.mode).toBe('disk-boot');
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DISK_BOOT:windows-7-x86');
  });

  it('active l’ACPI et la NIC ne2k requises par l’invité', () => {
    const profile = getSystemById('windows-7-x86')?.launchProfiles[0];
    expect(profile?.hardwareProfile?.network).toBe('ne2k');
    expect(profile?.hardwareProfile?.acpi).toBe(true);
  });

  it('expose l’identité Lite x86 et une mémoire puissance de deux', () => {
    const system = getSystemById('windows-7-x86');
    const profile = system?.launchProfiles[0];
    expect(system?.displayName).toBe('Windows 7 Lite');
    expect(system?.versionLabel).toBe('Lite · x86');
    // v86 exige une puissance de deux : 1536 (préparé sous QEMU) est invalide.
    const memoryMiB = profile?.configuration?.memoryMiB ?? 0;
    expect(Number.isInteger(memoryMiB) && memoryMiB > 0 && (memoryMiB & (memoryMiB - 1)) === 0).toBe(
      true,
    );
    expect(memoryMiB).toBe(1024);
  });
});

describe('catalogue : profils matériels et preuves de démarrage', () => {
  it('chaque profil porte un matériel et un marqueur explicites', () => {
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        expect(profile.hardwareProfile?.network).toBeDefined();
        // L'OS opérationnel prouve son démarrage par LUMIBOOT_GUEST_READY ; une
        // session graphique exige en plus LUMIBOOT_DESKTOP_READY, et un média
        // importé est prouvé par une lecture disque (LUMIBOOT_DISK_BOOT), jamais
        // simulé côté JavaScript.
        expect(profile.readiness?.marker).toMatch(
          /^LUMIBOOT_(GUEST|DESKTOP)_READY:|^LUMIBOOT_DISK_BOOT:/,
        );
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

  it('devient disponible : image publiée (`imageRef`) + boot graphique réel validé', () => {
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

describe('catalogue : flavor Debian XFCE (image publiée + boot validé)', () => {
  it('expose le profil graphique XFCE avec son marqueur Desktop dédié', () => {
    const xfce = getSystemById('debian-12-i386-xfce');
    const profile = xfce?.launchProfiles[0];
    expect(profile?.engineId).toBe('v86');
    expect(profile?.executionMode).toBe('browser');
    expect(profile?.minMemoryMiB).toBe(1024);
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce');
    expect(profile?.hardwareProfile?.network).toBe('virtio');
  });

  it('devient disponible : image publiée (`imageRef`) + boot graphique réel validé', () => {
    const xfce = getSystemById('debian-12-i386-xfce');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386-xfce');
    // Image publiée et boot Xorg + XFCE prouvé (voir docs/debian-xfce.md).
    expect(xfce?.imageRef).toBe('debian-12-i386-xfce');
    expect(profile?.validated).toBe(true);
    expect(xfce?.availability).toBe('ready');
  });
});
