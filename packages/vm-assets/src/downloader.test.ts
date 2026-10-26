import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetCache } from './cache';
import { AssetError } from './errors';
import { downloadAsset } from './downloader';

vi.mock('./hash', () => ({
  sha256Hex: async (bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    if (text === 'ok') return 'sha-ok';
    if (text === 'hello world') return 'sha-hello-world';
    if (text === 'abcdef') return 'sha-abcdef';
    return `sha-${text}`;
  },
}));

function responseFromBody(body: string, init: ResponseInit): Response {
  return new Response(body, init);
}

function getRangeHeader(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === 'range' && typeof value === 'string') return value;
    }
    if (typeof record.get === 'function') {
      const value = record.get.call(headers, 'Range');
      if (typeof value === 'string') return value;
    }
    if (typeof record.forEach === 'function') {
      let range: string | null = null;
      record.forEach.call(headers, (value: unknown, key: unknown) => {
        if (typeof key === 'string' && key.toLowerCase() === 'range' && typeof value === 'string') {
          range = value;
        }
      });
      if (range !== null) return range;
    }
  }
  if (headers instanceof Headers) return headers.get('Range');
  if (Array.isArray(headers)) return new Headers(headers).get('Range');
  return new Headers(headers as HeadersInit).get('Range');
}

describe('downloadAsset', () => {
  it('returns a cached entry when the checksum, size and version match', async () => {
    const cache = new MemoryAssetCache();
    const bytes = new TextEncoder().encode('ok');
    await cache.set({
      ref: 'asset-1',
      bytes,
      sha256: 'sha-ok',
      size: bytes.byteLength,
      version: 'v1',
      downloadedAt: Date.now(),
    });

    const result = await downloadAsset(
      {
        ref: 'asset-1',
        url: 'https://example.test/asset-1',
        sha256: 'sha-ok',
        size: bytes.byteLength,
        version: 'v1',
      },
      { cache, fetchImpl: vi.fn() as unknown as typeof fetch },
    );

    expect(new TextDecoder().decode(result)).toBe('ok');
  });

  it('resumes a chunked download with a valid Content-Range', async () => {
    const cache = new MemoryAssetCache();
    const cachedBytes = new TextEncoder().encode('hello ');
    await cache.set({
      ref: 'asset-2',
      bytes: cachedBytes,
      sha256: 'sha-partial',
      size: 11,
      version: 'v2',
      downloadedAt: Date.now(),
    });

    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = getRangeHeader(init);
      expect(range).toBe('bytes=6-10');
      return responseFromBody('world', {
        status: 206,
        headers: {
          'Content-Range': 'bytes 6-10/11',
        },
      });
    }) as unknown as typeof fetch;

    const result = await downloadAsset(
      {
        ref: 'asset-2',
        url: 'https://example.test/asset-2',
        sha256: 'sha-hello-world',
        size: 11,
        version: 'v2',
      },
      {
        cache,
        fetchImpl,
        allowResume: true,
        chunkSizeBytes: 5,
      },
    );

    expect(new TextDecoder().decode(result)).toBe('hello world');
  });

  it('rejects an inconsistent Content-Range during a resume', async () => {
    const cache = new MemoryAssetCache();
    await cache.set({
      ref: 'asset-3',
      bytes: new TextEncoder().encode('abc'),
      sha256: 'sha-partial',
      size: 6,
      version: 'v3',
      downloadedAt: Date.now(),
    });

    await expect(
      downloadAsset(
        {
          ref: 'asset-3',
          url: 'https://example.test/asset-3',
          sha256: 'sha-abcdef',
          size: 6,
          version: 'v3',
        },
        {
          cache,
          fetchImpl: async () =>
            responseFromBody('def', {
              status: 206,
              headers: {
                'Content-Range': 'bytes 2-4/6',
              },
            }),
          allowResume: true,
        },
      ),
    ).rejects.toBeInstanceOf(AssetError);
  });

  it('rejects an invalid checksum', async () => {
    await expect(
      downloadAsset(
        {
          ref: 'asset-4',
          url: 'https://example.test/asset-4',
          sha256: 'deadbeef',
          size: 2,
        },
        {
          fetchImpl: async () => responseFromBody('ok', { status: 200 }),
        },
      ),
    ).rejects.toBeInstanceOf(AssetError);
  });
});
