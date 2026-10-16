import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkLocalDiskAvailability,
  clearLocalDiskManifests,
  ensureLocalDiskManifest,
  getLocalDiskManifest,
} from './local-disk';

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

/** Forme PUBLIQUE : sans `source` (chemin réel) ni `provenance` (interne). */
function publicDiskManifest(ref = 'windows-7-x86') {
  const full = validDiskManifest(ref) as Record<string, unknown>;
  delete full.source;
  delete full.provenance;
  return full;
}

function fakeHeaders(record: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) lower[key.toLowerCase()] = value;
  return { get: (name: string): string | null => lower[name.toLowerCase()] ?? null };
}

function fakeResponse(payload: unknown, init: { status?: number; contentType?: string } = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': init.contentType ?? 'application/json' }),
    json: async () => payload,
    body: null,
  } as unknown as Response;
}

function htmlResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': 'text/html; charset=utf-8' }),
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
    body: null,
  } as unknown as Response;
}

function rangeResponse(total: number) {
  return {
    ok: true,
    status: 206,
    headers: fakeHeaders({ 'content-range': `bytes 0-0/${total}` }),
    json: async () => ({}),
    body: null,
  } as unknown as Response;
}

function binaryResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders({ 'content-type': 'application/octet-stream' }),
    json: async () => ({}),
    body: null,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  it('charge, valide et enregistre un manifeste disque privé valide', async () => {
    vi.stubGlobal('fetch', mockFetch(validDiskManifest()));

    const manifest = await ensureLocalDiskManifest('windows-7-x86');

    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest.boot.async).toBe(true);
    expect(getLocalDiskManifest('windows-7-x86')).not.toBeNull();
  });

  it('accepte la forme PUBLIQUE servie par HTTP (sans source ni provenance)', async () => {
    vi.stubGlobal('fetch', mockFetch(publicDiskManifest()));

    const manifest = await ensureLocalDiskManifest('windows-7-x86');

    expect(manifest.ref).toBe('windows-7-x86');
    expect(manifest).not.toHaveProperty('source');
    expect(manifest).not.toHaveProperty('provenance');
    expect(manifest.boot.async).toBe(true);
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

  it('signale un repli HTML SPA au lieu d’un manifeste JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(200)) as unknown as typeof fetch);
    await expect(ensureLocalDiskManifest('windows-7-x86')).rejects.toMatchObject({
      code: 'ASSET_INVALID_MANIFEST',
    });
  });

  it('n’interrompt PAS le chargement partagé quand le premier demandeur annule', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const gate = deferred<void>();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      await gate.promise;
      return fakeResponse(publicDiskManifest());
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const first = ensureLocalDiskManifest('windows-7-x86', controller.signal);
    const second = ensureLocalDiskManifest('windows-7-x86');

    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'ASSET_ABORTED' });
    expect(signals[0]?.aborted).toBe(false);

    gate.resolve();
    await expect(second).resolves.toMatchObject({ ref: 'windows-7-x86' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recharge après un échec (jamais mis en cache)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      return call === 1 ? fakeResponse({}, { status: 404 }) : fakeResponse(publicDiskManifest());
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureLocalDiskManifest('windows-7-x86')).rejects.toMatchObject({
      code: 'ASSET_NOT_FOUND',
    });
    await expect(ensureLocalDiskManifest('windows-7-x86')).resolves.toMatchObject({
      ref: 'windows-7-x86',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('checkLocalDiskAvailability', () => {
  it('déclare le disque disponible quand le manifeste est valide et le disque en 206', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(publicDiskManifest());
      return rangeResponse(100);
    });

    const result = await checkLocalDiskAvailability('windows-7-x86', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ref: 'windows-7-x86', available: true, size: 100 });
  });

  it('signale un manifeste absent (404)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({}, { status: 404 }));

    const result = await checkLocalDiskAvailability('windows-7-x86', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-missing' });
  });

  it('signale un repli HTML SPA au lieu du manifeste JSON', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(200));

    const result = await checkLocalDiskAvailability('windows-7-x86', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'manifest-html' });
  });

  it('signale l’absence de support Range (200 au lieu de 206)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(publicDiskManifest());
      return binaryResponse(200);
    });

    const result = await checkLocalDiskAvailability('windows-7-x86', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'range-unsupported' });
  });

  it('signale une taille de disque incohérente', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return fakeResponse(publicDiskManifest());
      return rangeResponse(999);
    });

    const result = await checkLocalDiskAvailability('windows-7-x86', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ available: false, reason: 'disk-mismatch' });
  });
});
