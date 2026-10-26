import { describe, expect, it } from 'vitest';
import {
  clearImageManifests,
  getImageManifest,
  registerImageManifest,
  resolveImage,
} from './manifest';

describe('vm-assets manifest registry', () => {
  it('registers and resolves a manifest', () => {
    clearImageManifests();
    registerImageManifest({
      ref: 'debian-test',
      architecture: 'i386',
      memoryMiB: 128,
      files: {
        'disk.img': { url: 'https://example.test/disk.img', sha256: 'abc', size: 3 },
      },
      license: 'MIT',
    });

    expect(getImageManifest('debian-test')?.license).toBe('MIT');
    expect(
      resolveImage({
        id: 'debian-test-system',
        slug: 'debian-test-system',
        family: 'linux',
        displayName: 'Debian',
        versionLabel: 'test',
        architecture: 'i386',
        availability: 'planned',
        description: 'desc',
        iconUrl: '/icon.svg',
        imageRef: 'debian-test',
        launchProfiles: [
          {
            id: 'default',
            engineId: 'v86',
            executionMode: 'browser',
            minMemoryMiB: 128,
          },
        ],
        requirements: ['r'],
        accent: '#000',
        accentRgb: '0,0,0',
        integrationNote: 'note',
      }),
    ).toMatchObject({ ref: 'debian-test' });
  });
});
