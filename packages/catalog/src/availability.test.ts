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
  it('marks ready only when the four conditions are met', () => {
    expect(getEffectiveAvailability(allFacts)).toBe('ready');
  });

  it('does not make a system without an image available', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false })).toBe('planned');
  });

  it('does not make a system with an image but a non-integrated engine available', () => {
    expect(getEffectiveAvailability({ ...allFacts, engineIntegrated: false })).toBe('planned');
  });

  it('does not make a system without a compatible profile available', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasCompatibleProfile: false })).toBe('planned');
  });

  it('does not make a non-validated system available', () => {
    expect(getEffectiveAvailability({ ...allFacts, validated: false })).toBe('planned');
  });

  it('downgrades a declared but unproven ready', () => {
    expect(getEffectiveAvailability({ ...allFacts, hasImage: false, declared: 'ready' })).toBe(
      'planned',
    );
  });
});

describe('getAggregatedAvailability (audit #19)', () => {
  it('ready when the SAME candidate meets the four conditions', () => {
    expect(getAggregatedAvailability([allFacts])).toBe('ready');
  });

  it('does not mix the validation of one profile with the engine of another', () => {
    // A: validated without an integrated engine. B: the opposite.
    // Independent `some()` calls would produce a false `ready`.
    const candidates: SystemAvailabilityFacts[] = [
      { ...allFacts, engineIntegrated: false, validated: true },
      { ...allFacts, engineIntegrated: true, validated: false },
    ];
    expect(getAggregatedAvailability(candidates)).toBe('planned');
  });

  it('ready as soon as one consistent candidate ticks everything, even among partial ones', () => {
    const candidates: SystemAvailabilityFacts[] = [
      { ...allFacts, engineIntegrated: false },
      { ...allFacts },
    ];
    expect(getAggregatedAvailability(candidates)).toBe('ready');
  });

  it('without any candidate: planned', () => {
    expect(getAggregatedAvailability([])).toBe('planned');
  });
});

describe('catalog: consistent effective availability', () => {
  it('marks Debian ready (image + integrated v86 engine + validated boot)', () => {
    const debian = getSystemById('debian-12-i386');
    const profile = debian?.launchProfiles[0];
    expect(debian?.imageRef).toBeDefined();
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    expect(debian?.availability).toBe('ready');
  });

  it('keeps the other systems at planned', () => {
    expect(getSystemById('ubuntu-18-i386')?.availability).toBe('planned');
    expect(getSystemById('fedora-workstation')?.availability).toBe('planned');
    expect(getSystemById('macos-sequoia')?.availability).toBe('planned');
  });

  it('does not make a system with a non-integrated engine available', () => {
    const fedora = getSystemById('fedora-workstation');
    const profile = fedora?.launchProfiles[0];
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(false);
    expect(fedora?.availability).not.toBe('ready');
  });

  it('does not make a system without a referenced image available', () => {
    const ubuntu = getSystemById('ubuntu-18-i386');
    expect(ubuntu?.imageRef).toBeUndefined();
    expect(ubuntu?.availability).not.toBe('ready');
  });
});

describe('getEffectiveAvailability: user media required', () => {
  it('marks resource-required when the user media is missing', () => {
    expect(
      getEffectiveAvailability({
        ...allFacts,
        hasImage: false,
        validated: false,
        requiresUserMedia: true,
      }),
    ).toBe('resource-required');
  });

  it('does not hide a declared unavailable state', () => {
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

  it('stays ready if a candidate ticks the four conditions', () => {
    expect(getAggregatedAvailability([{ ...allFacts, requiresUserMedia: true }])).toBe('ready');
  });

  it('resource-required wins over planned in the aggregation', () => {
    expect(
      getAggregatedAvailability([
        { ...allFacts, hasImage: false, validated: false },
        { ...allFacts, hasImage: false, validated: false, requiresUserMedia: true },
      ]),
    ).toBe('resource-required');
  });
});

describe('catalog: Windows 7 Professional (validated child) under v86', () => {
  it('is selectable, with an integrated v86 engine and availability derived from validated', () => {
    const windows = getSystemById('windows-7-pro-sp1-x86');
    const profile = windows?.launchProfiles[0];
    const definition = launchProfiles.find((candidate) => candidate.id === 'windows-7-pro-sp1-x86');
    expect(windows).not.toBeNull();
    expect(windows?.family).toBe('windows');
    expect(windows?.architecture).toBe('i386');
    expect(profile?.engineId).toBe('v86');
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    // `validated` lives on the catalog definition, not on the contract.
    expect(definition?.validated).toBe(true);
    // Availability follows `validated`; it is never hard-coded.
    expect(windows?.availability).toBe(definition?.validated ? 'ready' : 'planned');
  });

  it('references the local RAW disk of the codebase (no more media to import)', () => {
    // The local disk is referenced: no more `resource-required`.
    expect(getSystemById('windows-7-pro-sp1-x86')?.imageRef).toBe('windows-7-pro-sp1-x86');
    expect(getSystemById('windows-7-pro-sp1-x86')?.mediaStrategy).toBe('bundled');
    expect(getSystemById('windows-7-pro-sp1-x86')?.availability).toBe('ready');
  });

  it('uses a disk boot proof (no simulated guest marker)', () => {
    const profile = getSystemById('windows-7-pro-sp1-x86')?.launchProfiles[0];
    expect(profile?.readiness?.mode).toBe('disk-boot');
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86');
  });

  it('enables ACPI and the ne2k NIC required by the guest', () => {
    const profile = getSystemById('windows-7-pro-sp1-x86')?.launchProfiles[0];
    expect(profile?.hardwareProfile?.network).toBe('ne2k');
    expect(profile?.hardwareProfile?.acpi).toBe(true);
  });

  it('exposes the Professional SP1 x86 identity and the 1536 MiB accepted by v86', () => {
    const system = getSystemById('windows-7-pro-sp1-x86');
    const profile = system?.launchProfiles[0];
    expect(system?.displayName).toBe('Windows 7 (Professional)');
    expect(system?.versionLabel).toBe('SP1 · x86');
    // v86 accepts non-power-of-two memory; 1536 MiB is what the guest needs.
    expect(profile?.configuration?.memoryMiB).toBe(1536);
    expect(profile?.minMemoryMiB).toBe(1536);
  });

  it('is attached to the neutral parent `windows-7-x86` as the default variant', () => {
    const system = getSystemById('windows-7-pro-sp1-x86');
    expect(system?.variantGroupId).toBe('windows-7-x86');
    expect(system?.variantName).toBe('Professional');
    expect(system?.variantOrder).toBe(1);
  });
});

describe('catalog: Windows 7 Lite (group parent) under v86', () => {
  it('is the neutral parent of the group, with its local 16 GiB RAW disk', () => {
    const lite = getSystemById('windows-7-x86');
    const profile = lite?.launchProfiles[0];
    expect(lite).not.toBeNull();
    expect(lite?.family).toBe('windows');
    expect(lite?.architecture).toBe('i386');
    // The parent carries the group: no `variantGroupId`.
    expect(lite?.variantGroupId).toBeUndefined();
    expect(lite?.variantName).toBe('Lite');
    expect(lite?.variantOrder).toBe(2);
    expect(lite?.imageRef).toBe('windows-7-x86');
    expect(lite?.mediaStrategy).toBe('bundled');
    expect(profile?.engineId).toBe('v86');
  });

  it('derives availability from `validated` and is `ready` (real boot proven)', () => {
    const lite = getSystemById('windows-7-x86');
    const definition = launchProfiles.find((candidate) => candidate.id === 'windows-7-x86');
    // `validated` lives on the catalog definition, follow it rather than declaring.
    expect(definition?.validated).toBe(true);
    expect(lite?.availability).toBe(definition?.validated ? 'ready' : 'planned');
    // Real desktop boot proven by the E2E suite.
    expect(lite?.availability).toBe('ready');
  });

  it('uses a dedicated disk boot proof', () => {
    const profile = getSystemById('windows-7-x86')?.launchProfiles[0];
    expect(profile?.readiness?.mode).toBe('disk-boot');
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DISK_BOOT:windows-7-x86');
  });

  it('enables ACPI and the ne2k NIC and requires 1024 MiB', () => {
    const profile = getSystemById('windows-7-x86')?.launchProfiles[0];
    expect(profile?.hardwareProfile?.network).toBe('ne2k');
    expect(profile?.hardwareProfile?.acpi).toBe(true);
    expect(profile?.configuration?.memoryMiB).toBe(1024);
    expect(profile?.minMemoryMiB).toBe(1024);
  });
});

describe('catalog: Windows 10 x86 (parent) under v86', () => {
  it('has an image plus an integrated v86 engine and is validated (`ready`)', () => {
    const system = getSystemById('windows-10-x86');
    const profile = system?.launchProfiles[0];
    const definition = launchProfiles.find((candidate) => candidate.id === 'windows-10-x86');
    expect(system).not.toBeNull();
    expect(system?.family).toBe('windows');
    expect(system?.architecture).toBe('i386');
    expect(system?.imageRef).toBe('windows-10-x86');
    expect(profile?.engineId).toBe('v86');
    expect(profile && isEngineIntegrated(profile.engineId)).toBe(true);
    // Availability follows `validated`, as for Professional.
    expect(definition?.validated).toBe(true);
    // The derived availability is `ready`.
    expect(system?.availability).toBe('ready');
  });

  it('is `ready`: same validated pipeline as Windows 7', () => {
    const definition = launchProfiles.find((candidate) => candidate.id === 'windows-10-x86');
    expect(definition?.validated).toBe(true);
    expect(getSystemById('windows-10-x86')?.availability).toBe('ready');
  });
});

describe('catalog: hardware profiles and boot proofs', () => {
  it('every profile carries explicit hardware and marker', () => {
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        expect(profile.hardwareProfile?.network).toBeDefined();
        // Markers come from the real guest, both for OS and graphical proofs.
        expect(profile.readiness?.marker).toMatch(
          /^LUMIBOOT_(GUEST|DESKTOP)_READY:|^LUMIBOOT_DISK_BOOT:/,
        );
      }
    }
  });

  it('respects the documented hardware choices', () => {
    expect(getSystemById('debian-12-i386')?.launchProfiles[0]?.hardwareProfile?.network).toBe(
      'virtio',
    );
    expect(getSystemById('ubuntu-18-i386')?.launchProfiles[0]?.hardwareProfile?.network).toBe(
      'virtio',
    );
    expect(
      getSystemById('windows-7-pro-sp1-x86')?.launchProfiles[0]?.hardwareProfile?.network,
    ).toBe('ne2k');
  });

  it('keeps the historical Debian marker', () => {
    expect(getSystemById('debian-12-i386')?.launchProfiles[0]?.readiness?.marker).toBe(
      'LUMIBOOT_GUEST_READY:debian-12-i386',
    );
  });
});

describe('catalog: Debian Desktop flavor (published image + validated boot)', () => {
  it('exposes the graphical profile with its dedicated Desktop marker', () => {
    const desktop = getSystemById('debian-12-i386-desktop');
    const profile = desktop?.launchProfiles[0];
    expect(profile?.engineId).toBe('v86');
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop');
    expect(profile?.hardwareProfile?.network).toBe('virtio');
  });

  it('becomes available: published image (`imageRef`) + real validated graphical boot', () => {
    const desktop = getSystemById('debian-12-i386-desktop');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386-desktop');
    // Published image with a proven Xorg + Openbox boot.
    expect(desktop?.imageRef).toBe('debian-12-i386-desktop');
    expect(profile?.validated).toBe(true);
    expect(desktop?.availability).toBe('ready');
  });

  it('leaves the Debian console profile unchanged and ready', () => {
    const consoleSystem = getSystemById('debian-12-i386');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386');
    expect(consoleSystem?.imageRef).toBeDefined();
    expect(profile?.validated).toBe(true);
    expect(consoleSystem?.availability).toBe('ready');
  });
});

describe('catalog: Debian XFCE flavor (published image + validated boot)', () => {
  it('exposes the XFCE graphical profile with its dedicated Desktop marker', () => {
    const xfce = getSystemById('debian-12-i386-xfce');
    const profile = xfce?.launchProfiles[0];
    expect(profile?.engineId).toBe('v86');
    expect(profile?.executionMode).toBe('browser');
    expect(profile?.minMemoryMiB).toBe(1024);
    expect(profile?.readiness?.marker).toBe('LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce');
    expect(profile?.hardwareProfile?.network).toBe('virtio');
  });

  it('becomes available: published image (`imageRef`) + real validated graphical boot', () => {
    const xfce = getSystemById('debian-12-i386-xfce');
    const profile = launchProfiles.find((candidate) => candidate.id === 'debian-12-i386-xfce');
    // Published image with a proven Xorg + XFCE boot.
    expect(xfce?.imageRef).toBe('debian-12-i386-xfce');
    expect(profile?.validated).toBe(true);
    expect(xfce?.availability).toBe('ready');
  });
});
