import { describe, expect, it, vi } from 'vitest';
import { MemoryAssetCache } from './cache';
import { AssetError } from './errors';
import { downloadAsset } from './downloader';

describe('downloadAsset', () => {
    it('retourne une entrée mise en cache lorsque le checksum concorde', async () => {
        const cache = new MemoryAssetCache();
        const bytes = new TextEncoder().encode('ok');
        await cache.set({
            ref: 'asset-1',
            bytes,
            sha256:
                '2689367b205c16ce32ed44438a1bf8f7d3b8f0f5f94d8d0e8f7f0f0d9e0f2f7b',
            size: bytes.byteLength,
            downloadedAt: Date.now(),
        });

        const result = await downloadAsset(
            {
                ref: 'asset-1',
                url: 'https://example.test/asset-1',
                sha256:
                    '2689367b205c16ce32ed44438a1bf8f7d3b8f0f5f94d8d0e8f7f0f0d9e0f2f7b',
                size: bytes.byteLength,
            },
            { cache, fetchImpl: vi.fn() as unknown as typeof fetch },
        );

        expect(new TextDecoder().decode(result)).toBe('ok');
    });

    it('rejette un checksum invalide', async () => {
        await expect(
            downloadAsset(
                {
                    ref: 'asset-2',
                    url: 'https://example.test/asset-2',
                    sha256: 'deadbeef',
                    size: 2,
                },
                {
                    fetchImpl: async () => new Response('ok', { status: 200 }),
                },
            ),
        ).rejects.toBeInstanceOf(AssetError);
    });
});