import { AssetError } from './errors';

export interface CachedAsset {
    readonly ref: string;
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly size: number;
    readonly downloadedAt: number;
}

export interface AssetCache {
    get(ref: string): Promise<CachedAsset | null> | CachedAsset | null;
    set(asset: CachedAsset): Promise<void> | void;
    delete(ref: string): Promise<boolean> | boolean;
    clear(): Promise<void> | void;
}

export interface MemoryAssetCacheOptions {
    quotaBytes?: number;
}

export class MemoryAssetCache implements AssetCache {
    readonly #entries = new Map<string, CachedAsset>();
    readonly #quotaBytes: number | null;

    constructor(options: MemoryAssetCacheOptions = {}) {
        this.#quotaBytes = options.quotaBytes ?? null;
    }

    async get(ref: string): Promise<CachedAsset | null> {
        return this.#entries.get(ref) ?? null;
    }

    async set(asset: CachedAsset): Promise<void> {
        const nextSize = this.#usedBytes() - (this.#entries.get(asset.ref)?.bytes.byteLength ?? 0) + asset.bytes.byteLength;
        if (this.#quotaBytes !== null && nextSize > this.#quotaBytes) {
            throw new AssetError('ASSET_CACHE_QUOTA_EXCEEDED', 'Quota de cache dépassée.', {
                ref: asset.ref,
            });
        }
        this.#entries.set(asset.ref, asset);
    }

    async delete(ref: string): Promise<boolean> {
        return this.#entries.delete(ref);
    }

    async clear(): Promise<void> {
        this.#entries.clear();
    }

    #usedBytes(): number {
        let total = 0;
        for (const entry of this.#entries.values()) total += entry.bytes.byteLength;
        return total;
    }
}