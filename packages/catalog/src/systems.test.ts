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
    // The runtime check knows what to probe.
    expect(windows.imageRef).toBeDefined();
  });

  it('a user-import system without media stays "resource-required" with media "user-import"', () => {
    const windows = getSystemById('windows-11-x64')!;
    expect(getDeclaredReadiness(windows)).toEqual({
      availability: 'resource-required',
      mediaSource: 'user-import',
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

/** Windows 10 x86 reuses the validated Windows 7 disk pipeline. */
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
