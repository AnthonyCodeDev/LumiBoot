import { describe, expect, it } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { getSystemById } from '@lumiboot/catalog';
import {
  checkSystemRuntimeAvailability,
  getLaunchReadiness,
  resolveLaunchReadiness,
} from './launch';
import { isEngineIntegrated } from './compatibility';

function system(id: string): OSDefinition {
  const found = getSystemById(id);
  if (!found) throw new Error(`test system not found: ${id}`);
  return found;
}

const HEX64 = 'a'.repeat(64);

/** Minimal JSON response compatible with `fetchJsonDocument`. */
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

/** Disk response for `probeRangeAvailability`. */
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
    displayName: 'Windows 7 x86 (local disk)',
    architecture: 'i386',
    memoryMiB: 1024,
    license: 'Local disk',
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
  it('allows a bundled ready system with an integrated engine', () => {
    expect(getLaunchReadiness(system('debian-12-i386'))).toEqual({ canLaunch: true });
  });

  it('refuses a not-ready system whose engine is not integrated', () => {
    const readiness = getLaunchReadiness(system('fedora-workstation'));
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.reason).toMatch(/not ready|integrated/i);
  });

  it('allows Windows 7 Professional straight from the local disk, without imported media', () => {
    expect(getLaunchReadiness(system('windows-7-pro-sp1-x86'))).toEqual({ canLaunch: true });
  });

  it('refuses a user-import system until the media is imported, then allows it', () => {
    const userImport: OSDefinition = { ...system('debian-12-i386'), mediaStrategy: 'user-import' };

    const withoutMedia = getLaunchReadiness(userImport, { userMediaReady: false });
    expect(withoutMedia.canLaunch).toBe(false);
    expect(withoutMedia.reason).toMatch(/import a disk media/i);

    const withMedia = getLaunchReadiness(userImport, { userMediaReady: true });
    expect(withMedia).toEqual({ canLaunch: true });
  });

  it('explicitly refuses an architecture the engine does not serve (x86_64 under v86)', () => {
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

  it('blocks 64-bit Windows 11 while the wasm-x86_64 engine is not integrated', () => {
    // v86 only emulates 32-bit x86; `wasm-x86_64` is not integrated.
    const windows = system('windows-11-x64');
    expect(isEngineIntegrated(windows.launchProfiles[0]!.engineId)).toBe(false);
    const readiness = getLaunchReadiness(windows);
    expect(readiness.canLaunch).toBe(false);
    // Not developed: refused as not ready, with no media to import.
    expect(readiness.reason).toMatch(/not ready/i);
  });

  it('allows the generic custom image once a user media is imported', () => {
    const custom = system('custom-image');
    expect(custom.mediaStrategy).toBe('user-import');
    // Integrated v86 engine, but nothing is distributed.
    expect(isEngineIntegrated(custom.launchProfiles[0]!.engineId)).toBe(true);

    const withoutMedia = getLaunchReadiness(custom, { userMediaReady: false });
    expect(withoutMedia.canLaunch).toBe(false);
    expect(withoutMedia.reason).toMatch(/import a disk media/i);

    expect(getLaunchReadiness(custom, { userMediaReady: true })).toEqual({ canLaunch: true });
  });
});

describe('checkSystemRuntimeAvailability', () => {
  it('confirms a bundled system served with a manifest and HTTP Range', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return jsonResponse(debianImageManifest(10));
      return rangeResponse(206, 'bytes 0-0/10');
    }) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result).toEqual({ available: true, size: 10 });
  });

  it('explicitly explains a missing manifest (HTTP 404)', async () => {
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

  it('explicitly explains an SPA HTML fallback', async () => {
    const fetchImpl = (async () =>
      jsonResponse('<html></html>', 'text/html; charset=utf-8')) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/HTML/i);
  });

  it('explicitly explains the lack of HTTP Range support (HTTP 200)', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return jsonResponse(debianImageManifest(10));
      return rangeResponse(200);
    }) as unknown as typeof fetch;

    const result = await checkSystemRuntimeAvailability(system('debian-12-i386'), { fetchImpl });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/Range/);
  });

  it('checks a local disk (disk-boot) through its manifest and HTTP Range', async () => {
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
  it('combines declared readiness and runtime availability', async () => {
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

  it('never queries the network for a system refused by the catalogue', async () => {
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
