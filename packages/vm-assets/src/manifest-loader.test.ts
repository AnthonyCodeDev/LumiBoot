import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearImageManifests, getImageManifest } from './manifest';
import { ensureImageManifest } from './manifest-loader';

function validManifest(ref = 'debian-12-i386') {
  return {
    ref,
    architecture: 'i386',
    memoryMiB: 512,
    vgaMemoryMiB: 16,
    license: 'Debian GNU/Linux',
    files: {
      disk: { url: `/images/${ref}/rootfs.img`, sha256: 'a'.repeat(64), size: 100 },
      bzimage: { url: `/images/${ref}/vmlinuz-686`, sha256: 'b'.repeat(64), size: 20 },
      initrd: { url: `/images/${ref}/initrd.img`, sha256: 'c'.repeat(64), size: 30 },
    },
  };
}

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

afterEach(() => {
  clearImageManifests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ensureImageManifest', () => {
  it('charge, valide et enregistre un manifeste valide', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest()));

    const manifest = await ensureImageManifest('debian-12-i386');

    expect(manifest.ref).toBe('debian-12-i386');
    expect(getImageManifest('debian-12-i386')).not.toBeNull();
  });

  it('rejette un manifeste placeholder (champs inconnus et fichiers manquants)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        $comment: 'placeholder',
        ref: 'debian-12-i386',
        architecture: 'i386',
        memoryMiB: 512,
        license: 'x',
        files: {},
        status: 'not-built',
      }),
    );

    await expect(ensureImageManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('rejette une référence de manifeste différente de la demande', async () => {
    vi.stubGlobal('fetch', mockFetch(validManifest('autre-image')));

    await expect(ensureImageManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('ne déclenche qu’une seule requête pour des appels concurrents', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      ensureImageManifest('debian-12-i386'),
      ensureImageManifest('debian-12-i386'),
    ]);

    expect(first.ref).toBe(second.ref);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejette une référence dynamique invalide sans requête', async () => {
    const fetchMock = mockFetch(validManifest());
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureImageManifest('../evil')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
