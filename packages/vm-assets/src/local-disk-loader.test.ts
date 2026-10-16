import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLocalDiskManifests, ensureLocalDiskManifest, getLocalDiskManifest } from './local-disk';

function validDiskManifest(ref = 'windows-7-x86') {
  return {
    version: 1,
    ref,
    displayName: 'Windows 7 x86 (média local)',
    architecture: 'i386',
    memoryMiB: 1024,
    vgaMemoryMiB: 16,
    license: 'Licence utilisateur',
    provenance: 'Disque local',
    source: { path: 'C:/Windows7.img', size: 100, mtimeMs: 1 },
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: `/images/${ref}/disk.img`,
      size: 100,
      mtimeMs: 1,
      sha256: 'a'.repeat(64),
    },
    engine: {
      id: 'v86',
      wasm: { url: '/v86/v86.wasm', size: 1, sha256: 'b'.repeat(64) },
      bios: {
        seabios: { url: '/v86/seabios.bin', size: 1, sha256: 'c'.repeat(64) },
        vgabios: { url: '/v86/vgabios.bin', size: 1, sha256: 'd'.repeat(64) },
      },
    },
    boot: { mode: 'disk-boot', url: `/images/${ref}/disk.img`, async: true, size: 100 },
  };
}

function mockFetch(payload: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({ ok, status, json: async () => payload })) as unknown as typeof fetch;
}

afterEach(() => {
  clearLocalDiskManifests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ensureLocalDiskManifest', () => {
  it('charge, valide et enregistre un manifeste disque valide', async () => {
    vi.stubGlobal('fetch', mockFetch(validDiskManifest()));

    const manifest = await ensureLocalDiskManifest('windows-7-x86');

    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest.boot.async).toBe(true);
    expect(getLocalDiskManifest('windows-7-x86')).not.toBeNull();
  });

  it('rejette un manifeste d’image publiée (schéma disque strict)', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ref: 'debian-12-i386',
        architecture: 'i386',
        memoryMiB: 512,
        license: 'x',
        files: { disk: {}, bzimage: {}, initrd: {} },
      }),
    );

    await expect(ensureLocalDiskManifest('debian-12-i386')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('rejette une référence de manifeste différente de la demande', async () => {
    vi.stubGlobal('fetch', mockFetch(validDiskManifest('autre-image')));

    await expect(ensureLocalDiskManifest('windows-7-x86')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('ne déclenche qu’une seule requête pour des appels concurrents', async () => {
    const fetchMock = mockFetch(validDiskManifest());
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      ensureLocalDiskManifest('windows-7-x86'),
      ensureLocalDiskManifest('windows-7-x86'),
    ]);

    expect(first.ref).toBe(second.ref);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejette une référence dynamique invalide sans requête', async () => {
    const fetchMock = mockFetch(validDiskManifest());
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureLocalDiskManifest('../evil')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signale un manifeste inaccessible (HTTP non ok)', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false, 404));
    await expect(ensureLocalDiskManifest('windows-7-x86')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
  });
});
