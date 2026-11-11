import { describe, expect, it } from 'vitest';
import { getDeclaredReadiness, getSystemById, systems } from './systems';

/** Declared readiness never assumes the media is servable at runtime. */
describe('getDeclaredReadiness — declared / runtime separation', () => {
  it('a validated bundled system is declared ready, media "bundled-image"', () => {
    const debian = getSystemById('debian-12-i386')!;
    expect(getDeclaredReadiness(debian)).toEqual({
      availability: 'ready',
      mediaSource: 'bundled-image',
    });
  });

  it('Windows 7 (local disk) is declared ready but media "local-disk" must be checked at runtime', () => {
    const windows = getSystemById('windows-7-pro-sp1-x86')!;
    expect(getDeclaredReadiness(windows)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
    expect(windows.imageRef).toBeDefined();
  });

  it('a user-import system without media stays "resource-required" with media "user-import"', () => {
    const custom = getSystemById('custom-image')!;
    expect(getDeclaredReadiness(custom)).toEqual({
      availability: 'resource-required',
      mediaSource: 'user-import',
    });
    expect(custom.imageRef).toBeUndefined();
  });

  it('Windows 11 (local UEFI disk) is declared ready, media "local-disk"', () => {
    const windows = getSystemById('windows-11-x64')!;
    expect(windows.mediaStrategy).toBe('bundled');
    expect(windows.imageRef).toBe('windows-11-x64');
    expect(getDeclaredReadiness(windows)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
  });

  it('every declared "local-disk" media references an image', () => {
    for (const system of systems) {
      const declared = getDeclaredReadiness(system);
      if (declared.mediaSource === 'local-disk') {
        expect(system.imageRef, `${system.id} must reference a local disk`).toBeDefined();
      }
    }
  });
});

describe('Windows 10 x86 — local disk pipeline under v86', () => {
  it('exposes the installed local RAW disk and the default "bundled" media', () => {
    const system = getSystemById('windows-10-x86')!;
    expect(system.architecture).toBe('i386');
    expect(system.imageRef).toBe('windows-10-x86');
    expect(system.mediaStrategy).toBe('bundled');
    expect(getDeclaredReadiness(system)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
  });

  it('uses v86, virtio + ACPI, 2048 MiB and the disk boot', () => {
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

  it('is `ready`: validated local disk pipeline', () => {
    const system = getSystemById('windows-10-x86')!;
    expect(system.availability).toBe('ready');
  });
});

describe('Custom image — user-import under the integrated v86 engine', () => {
  it('is the last catalogue entry, with the neutral `custom` family', () => {
    const system = getSystemById('custom-image')!;
    expect(systems[systems.length - 1]?.id).toBe('custom-image');
    expect(system.family).toBe('custom');
    expect(system.displayName).toBe('Custom image');
    expect(system.architecture).toBe('i386');
    expect(system.mediaStrategy).toBe('user-import');
    expect(system.imageRef).toBeUndefined();
  });

  it('stays `resource-required` while the media is missing', () => {
    expect(getSystemById('custom-image')!.availability).toBe('resource-required');
  });

  it('runs on the integrated v86 engine with 512 MiB and no fixed boot device', () => {
    const profile = getSystemById('custom-image')!.launchProfiles[0]!;
    expect(profile.engineId).toBe('v86');
    expect(profile.executionMode).toBe('browser');
    expect(profile.minMemoryMiB).toBe(512);
    expect(profile.configuration?.memoryMiB).toBe(512);
    // A fixed `disk` boot device would reject every ISO.
    expect(profile.configuration?.bootDevice).toBeUndefined();
    expect(profile.hardwareProfile?.network).toBe('virtio');
  });
});

/** macOS Lion boots from two local media: an OpenCore ESP on hda, the system on hdb. */
describe('macOS Lion x64 — v64 + OVMF + OpenCore ESP', () => {
  it('exposes the two local media and the default "bundled" strategy', () => {
    const system = getSystemById('macos-lion-x64')!;
    expect(system.family).toBe('macos');
    expect(system.architecture).toBe('x86_64');
    expect(system.imageRef).toBe('macos-lion-x64');
    expect(system.mediaStrategy).toBe('bundled');
    expect(system.displayName).toBe('macOS');
    expect(system.versionLabel).toBe('Lion 10.7.5 · x86');
    expect(getDeclaredReadiness(system)).toEqual({
      availability: 'ready',
      mediaSource: 'local-disk',
    });
  });

  it('declares UEFI/q35, the emulated SMC and USB HID input', () => {
    const profile = getSystemById('macos-lion-x64')!.launchProfiles[0]!;
    expect(profile.engineId).toBe('v64');
    expect(profile.executionMode).toBe('browser');
    expect(profile.minMemoryMiB).toBe(2048);
    expect(profile.configuration?.memoryMiB).toBe(2048);
    expect(profile.configuration?.vgaMemoryMiB).toBe(32);
    expect(profile.configuration?.bootDevice).toBe('disk');
    expect(profile.configuration?.extra).toEqual({
      v64Firmware: 'uefi',
      v64Machine: 'q35',
      v64Smc: true,
      v64UsbTablet: true,
      v64UsbKeyboard: true,
      v64CpuCores: 1,
    });
    expect(profile.hardwareProfile?.machine).toBe('q35');
    // The emulated SMC owns 0x300-0x31F: the guest is offline by construction.
    expect(profile.hardwareProfile?.network).toBe('none');
    expect(profile.hardwareProfile?.acpi).toBe(true);
    expect(profile.readiness?.mode).toBe('disk-boot');
    expect(profile.readiness?.marker).toBe('LUMIBOOT_DISK_BOOT:macos-lion-x64');
  });

  it('is `ready`: two published local media and a validated boot inside LumiBoot', () => {
    expect(getSystemById('macos-lion-x64')!.availability).toBe('ready');
  });
});

/** A CLI guest only talks on ttyS0: the session opens on its serial console. */
describe('displayMode — primary view declared per profile', () => {
  it('marks the two CLI profiles as `text`', () => {
    for (const systemId of ['debian-12-i386', 'ubuntu-18-i386']) {
      expect(getSystemById(systemId)!.launchProfiles[0]!.displayMode, systemId).toBe('text');
    }
  });

  it('marks every graphical profile as `graphical`', () => {
    const graphical = [
      'debian-12-i386-desktop',
      'debian-12-i386-xfce',
      'ubuntu-18-i386-desktop',
      'ubuntu-18-i386-xfce',
      'alpine-3-24-x86-64-xfce',
      'windows-7-x86',
      'windows-7-pro-sp1-x86',
      'windows-10-x86',
      'macos-lion-x64',
    ];
    for (const systemId of graphical) {
      expect(getSystemById(systemId)!.launchProfiles[0]!.displayMode, systemId).toBe('graphical');
    }
  });

  it('never exposes an `undefined` displayMode key, so absent means graphical', () => {
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        if (profile.displayMode === undefined) {
          expect(Object.hasOwn(profile, 'displayMode'), profile.id).toBe(false);
        } else {
          expect(['text', 'graphical']).toContain(profile.displayMode);
        }
      }
    }
    const custom = getSystemById('custom-image')!.launchProfiles[0]!;
    expect('displayMode' in custom).toBe(false);
  });
});
