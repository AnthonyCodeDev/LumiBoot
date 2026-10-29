import { describe, expect, it } from 'vitest';
import {
  DOWNLOADS_MANIFEST_URL,
  loadDownloadsManifest,
  resolveDownloadUrl,
  type DownloadsManifest,
} from './downloads';
import type { FetchLike } from './load-config';

/** A syntactically valid SHA-256 digest, used by the fixtures below. */
const SHA256 = '472828fb1a1335cef6b536a51a2f7ba5affad69af182ef02eade8ea27fc0bfc9';

const VALID_MANIFEST: DownloadsManifest = {
  version: '0.0.0',
  wispVersion: 1,
  generatedAt: null,
  platforms: {
    'windows-x64': {
      file: 'LumiBoot-Network-windows-amd64.exe',
      url: '/downloads/LumiBoot-Network-windows-amd64.exe',
      size: 123,
      sha256: SHA256,
      published: true,
    },
    'windows-arm64': {
      file: 'LumiBoot-Network-windows-arm64.exe',
      url: null,
      size: null,
      sha256: null,
      published: false,
    },
    'linux-x64': {
      file: 'LumiBoot-Network-linux-amd64.tar.gz',
      url: null,
      size: null,
      sha256: null,
      published: false,
    },
    'linux-arm64': {
      file: 'LumiBoot-Network-linux-arm64.tar.gz',
      url: null,
      size: null,
      sha256: null,
      published: false,
    },
    macos: {
      file: 'LumiBoot-Network-macos-universal.tar.gz',
      url: null,
      size: null,
      sha256: null,
      published: false,
      signed: false,
      notarized: false,
    },
  },
};

function fetchJson(body: unknown, ok = true): FetchLike {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 404,
      json: async () => body,
    }) as unknown as Response) as FetchLike;
}

describe('loadDownloadsManifest', () => {
  it('loads a valid manifest from the default URL', async () => {
    let seenUrl = '';
    const fetchImpl: FetchLike = (async (url: string) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => VALID_MANIFEST,
      } as unknown as Response;
    }) as FetchLike;
    const manifest = await loadDownloadsManifest(fetchImpl);
    expect(seenUrl).toBe(DOWNLOADS_MANIFEST_URL);
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.platforms['windows-x64'].file).toContain('.exe');
  });

  it('rejects an invalid manifest', async () => {
    await expect(loadDownloadsManifest(fetchJson({ version: 1 }))).rejects.toThrow(
      /Invalid downloads manifest/,
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    '//example.com/file.exe',
    'http://example.com/file.exe',
    'https://example.com/file.exe',
    'https://example.com/downloads/file.exe',
    '/\\example.com/file.exe',
    '/downloads/my file.exe',
    '/downloads/file.exe ',
  ])('rejects an unsafe download URL: %s', async (url) => {
    const manifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'windows-x64': { ...VALID_MANIFEST.platforms['windows-x64'], url },
      },
    };
    await expect(loadDownloadsManifest(fetchJson(manifest))).rejects.toThrow(
      /Invalid downloads manifest/,
    );
    expect(resolveDownloadUrl(manifest, 'windows-x64')).toBeNull();
  });

  it.each([
    ['too short', 'abc'],
    ['not hex', 'z'.repeat(64)],
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['with a prefix', `sha256:${'a'.repeat(64)}`],
  ])('rejects an invalid SHA-256 digest (%s)', async (_label, sha256) => {
    const manifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'windows-x64': { ...VALID_MANIFEST.platforms['windows-x64'], sha256 },
      },
    };
    await expect(loadDownloadsManifest(fetchJson(manifest))).rejects.toThrow(
      /Invalid downloads manifest/,
    );
    expect(resolveDownloadUrl(manifest, 'windows-x64')).toBeNull();
  });

  it('rejects an unknown platform key inside platforms', async () => {
    const manifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'freebsd-x64': VALID_MANIFEST.platforms['windows-x64'],
      },
    };
    await expect(loadDownloadsManifest(fetchJson(manifest))).rejects.toThrow(
      /Invalid downloads manifest/,
    );
  });

  it('accepts an uppercase SHA-256 digest', async () => {
    const manifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'windows-x64': {
          ...VALID_MANIFEST.platforms['windows-x64'],
          sha256: SHA256.toUpperCase(),
        },
      },
    };
    await expect(loadDownloadsManifest(fetchJson(manifest))).resolves.toEqual(manifest);
  });

  it('accepts a same-origin download path', async () => {
    const manifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'windows-x64': {
          ...VALID_MANIFEST.platforms['windows-x64'],
          url: '/downloads/LumiBoot-Network-windows-amd64.exe',
        },
      },
    };
    await expect(loadDownloadsManifest(fetchJson(manifest))).resolves.toEqual(manifest);
  });

  it('rejects a failing HTTP response', async () => {
    await expect(loadDownloadsManifest(fetchJson(null, false))).rejects.toThrow(/not found/);
  });
});

describe('resolveDownloadUrl', () => {
  it('published entry with URL, size and digest → url', () => {
    expect(resolveDownloadUrl(VALID_MANIFEST, 'windows-x64')).toBe(
      '/downloads/LumiBoot-Network-windows-amd64.exe',
    );
  });

  it('unpublished entry → null even with a URL', () => {
    const manifest: DownloadsManifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'linux-x64': {
          file: 'x.tar.gz',
          url: '/downloads/x.tar.gz',
          size: 1,
          sha256: SHA256,
          published: false,
        },
      },
    };
    expect(resolveDownloadUrl(manifest, 'linux-x64')).toBeNull();
  });

  it('published entry without URL → null', () => {
    const manifest: DownloadsManifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'linux-x64': {
          file: 'x.tar.gz',
          url: null,
          size: null,
          sha256: null,
          published: true,
        },
      },
    };
    expect(resolveDownloadUrl(manifest, 'linux-x64')).toBeNull();
  });

  // Injected manifests bypass the schema, so `resolveDownloadUrl` must still refuse them.
  it.each([
    ['a missing digest', { sha256: null }],
    ['a truncated digest', { sha256: 'abc' }],
    ['a missing size', { size: null }],
    ['a zero size', { size: 0 }],
    ['a negative size', { size: -1 }],
    ['a cross-origin HTTPS URL', { url: 'https://example.com/x.tar.gz' }],
  ])('published entry with %s → null', (_label, overrides) => {
    const manifest: DownloadsManifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'linux-x64': {
          file: 'x.tar.gz',
          url: '/downloads/x.tar.gz',
          size: 1,
          sha256: SHA256,
          published: true,
          ...overrides,
        },
      },
    };
    expect(resolveDownloadUrl(manifest, 'linux-x64')).toBeNull();
  });
});
