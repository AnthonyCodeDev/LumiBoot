import { describe, expect, it } from 'vitest';
import {
  DOWNLOADS_MANIFEST_URL,
  loadDownloadsManifest,
  resolveDownloadUrl,
  type DownloadsManifest,
} from './downloads';
import type { FetchLike } from './load-config';

const VALID_MANIFEST: DownloadsManifest = {
  version: '0.0.0',
  wispVersion: 1,
  generatedAt: null,
  platforms: {
    'windows-x64': {
      file: 'LumiBoot-Network-windows-amd64.exe',
      url: 'https://example.com/win-x64.exe',
      size: 123,
      sha256: 'abc',
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

  it('rejects a failing HTTP response', async () => {
    await expect(loadDownloadsManifest(fetchJson(null, false))).rejects.toThrow(/not found/);
  });
});

describe('resolveDownloadUrl', () => {
  it('published entry with URL → url', () => {
    expect(resolveDownloadUrl(VALID_MANIFEST, 'windows-x64')).toBe(
      'https://example.com/win-x64.exe',
    );
  });

  it('unpublished entry → null even with a URL', () => {
    const manifest: DownloadsManifest = {
      ...VALID_MANIFEST,
      platforms: {
        ...VALID_MANIFEST.platforms,
        'linux-x64': {
          file: 'x.tar.gz',
          url: 'https://example.com/x.tar.gz',
          size: 1,
          sha256: 's',
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
});
