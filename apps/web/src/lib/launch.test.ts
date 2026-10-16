import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { getSystemById } from '@lumiboot/catalog';
import {
  checkSystemRuntimeAvailability,
  getLaunchReadiness,
  resolveLaunchReadiness,
} from './launch';

function system(id: string): OSDefinition {
  const found = getSystemById(id);
  if (!found) throw new Error(`système de test introuvable : ${id}`);
  return found;
}

const HEX64 = 'a'.repeat(64);

/** Réponse JSON minimale compatible avec `fetchJsonDocument`. */
function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return {
    status: 200,
    ok: true,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

/** Réponse de disque pour `probeRangeAvailability`. */
function rangeResponse(status: number, contentRange?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === 'content-type') return 'application/octet-stream';
        if (lower === 'content-range') return contentRange ?? null;
        return null;
      },
    },
    json: async () => ({}),
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

function debianImageManifest(size: number): unknown {
  const file = (url: string) => ({ url, sha256: HEX64, size });
  return {
    ref: 'debian-12-i386',
    architecture: 'i386',
    memoryMiB: 512,
    license: 'Debian',
    files: {
      disk: file('/images/debian-12-i386/rootfs.img'),
      bzimage: file('/images/debian-12-i386/vmlinuz-686'),
      initrd: file('/images/debian-12-i386/initrd.img'),
    },
  };
}

function diskManifest(size: number): unknown {
  return {
    version: 1,
    ref: 'windows-7-x86',
    displayName: 'Windows 7 x86 (disque local)',
    architecture: 'i386',
    memoryMiB: 1024,
    license: 'Disque local',
    disk: {
      fileName: 'disk.img',
      format: 'raw',
      url: '/images/windows-7-x86/disk.img',
      size,
      mtimeMs: 1,
      sha256: HEX64,
    },
    engine: {
      id: 'v86',
      wasm: { url: '/v86/v86.wasm', size: 1, sha256: HEX64 },
      bios: {
        seabios: { url: '/v86/seabios.bin', size: 1, sha256: HEX64 },
        vgabios: { url: '/v86/vgabios.bin', size: 1, sha256: HEX64 },
      },
    },
    boot: { mode: 'disk-boot', url: '/images/windows-7-x86/disk.img', async: true, size },
  };
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

  it('autorise Windows 7 Professionnel directement depuis le disque local, sans média importé', () => {
    expect(getLaunchReadiness(system('windows-7-pro-sp1-x86'))).toEqual({ canLaunch: true });
  });

  it('refuse un système user-import tant que le média n’est pas importé, puis l’autorise', () => {
    const userImport: OSDefinition = { ...system('debian-12-i386'), mediaStrategy: 'user-import' };

    const withoutMedia = getLaunchReadiness(userImport, { userMediaReady: false });
    expect(withoutMedia.canLaunch).toBe(false);
    expect(withoutMedia.reason).toMatch(/importez un média/i);

    const withMedia = getLaunchReadiness(userImport, { userMediaReady: true });
    expect(withMedia).toEqual({ canLaunch: true });
  });

  it('refuse explicitement une architecture non servie par le moteur (x86_64 sous v86)', () => {
    const wrongArch: OSDefinition = {
      ...system('debian-12-i386'),
      id: 'debian-x64',
      slug: 'debian-x64',
      architecture: 'x86_64',
    };

    const readiness = getLaunchReadiness(wrongArch);
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.reason).toMatch(/x86_64/);
  });

  it('bloque Windows 10 64 bits tant que le moteur wasm-x86_64 n’est pas intégré', () => {
    // v86 n’émule que le x86 32 bits : le profil Windows 10 64 bits cible
    // `wasm-x86_64`, non intégré. Le lancement doit être refusé explicitement,
    // sans jamais promettre un boot (voir docs/windows-10.md).
    const readiness = getLaunchReadiness(system('windows-10-x64'));
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.reason).toMatch(/wasm-x86_64/);
  });
});

describe('checkSystemRuntimeAvailability', () => {
  it('confirme un système bundled servi avec manifeste et HTTP Range', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return jsonResponse(debianImageManifest(10));
      return rangeResponse(206, 'bytes 0-0/10');
    }) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result).toEqual({ available: true, size: 10 });
  });

  it('motiver explicitement un manifeste absent (HTTP 404)', async () => {
    const fetchImpl = (async () =>
      ({
        status: 404,
        ok: false,
        headers: { get: () => null },
        body: { cancel: async () => undefined },
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/404/);
  });

  it('motiver explicitement un repli HTML de SPA', async () => {
    const fetchImpl = (async () =>
      jsonResponse('<html></html>', 'text/html; charset=utf-8')) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/HTML/i);
  });

  it('motiver explicitement l’absence de support HTTP Range (HTTP 200)', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return jsonResponse(debianImageManifest(10));
      return rangeResponse(200);
    }) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/Range/);
  });

  it('vérifie un disque local (disk-boot) via son manifeste et son HTTP Range', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return jsonResponse(diskManifest(100));
      return rangeResponse(206, 'bytes 0-0/100');
    }) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('windows-7-x86'), { fetchImpl });
    expect(result).toEqual({ available: true, size: 100 });
  });
});

describe('resolveLaunchReadiness', () => {
  it('combine readiness déclarée et disponibilité runtime', async () => {
    const unavailable = (async () =>
      ({
        status: 404,
        ok: false,
        headers: { get: () => null },
        body: { cancel: async () => undefined },
      }) as unknown as Response) as unknown as typeof fetch;

    const result = await resolveLaunchReadiness(system('debian-12-i386'), {
      fetchImpl: unavailable,
    });
    expect(result.canLaunch).toBe(false);
    expect(result.reason).toMatch(/404/);
  });

  it('n’interroge jamais le réseau pour un système refusé par le catalogue', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return rangeResponse(200);
    }) as unknown as typeof fetch;

    const result = await resolveLaunchReadiness(system('fedora-workstation'), { fetchImpl });
    expect(result.canLaunch).toBe(false);
    expect(calls).toBe(0);
  });
});
