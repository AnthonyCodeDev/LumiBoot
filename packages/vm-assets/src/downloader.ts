import { sha256Hex } from './hash';
import type { AssetCache, CachedAsset } from './cache';
import { AssetError } from './errors';

export interface AssetDescriptor {
    readonly ref: string;
    readonly url: string;
    readonly sha256: string;
    readonly size: number;
}

export interface AssetDownloadProgress {
    readonly ref: string;
    readonly phase: 'cache' | 'download' | 'verify' | 'resume';
    readonly loadedBytes: number;
    readonly totalBytes?: number;
}

export interface DownloadAssetOptions {
    readonly cache?: AssetCache;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly allowResume?: boolean;
    readonly onProgress?: (progress: AssetDownloadProgress) => void;
}

export async function downloadAsset(
    descriptor: AssetDescriptor,
    options: DownloadAssetOptions = {},
): Promise<Uint8Array> {
    const cached = options.cache ? await options.cache.get(descriptor.ref) : null;
    if (cached && cached.sha256 === descriptor.sha256 && cached.size === descriptor.size) {
        options.onProgress?.({
            ref: descriptor.ref,
            phase: 'cache',
            loadedBytes: cached.bytes.byteLength,
            totalBytes: cached.bytes.byteLength,
        });
        return cached.bytes;
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new AssetError('ASSET_DOWNLOAD_FAILED', 'Aucun client HTTP n’est disponible.', {
            ref: descriptor.ref,
        });
    }

    const headers = new Headers();
    const partialBytes = options.allowResume && cached ? cached.bytes.byteLength : 0;
    if (partialBytes > 0) {
        headers.set('Range', `bytes=${partialBytes}-`);
        options.onProgress?.({
            ref: descriptor.ref,
            phase: 'resume',
            loadedBytes: partialBytes,
            totalBytes: descriptor.size,
        });
    }

    let response: Response;
    try {
        response = await fetchImpl(descriptor.url, {
            headers,
            signal: options.signal ?? null,
        });
    } catch (error) {
        if (options.signal?.aborted) {
            throw new AssetError('ASSET_ABORTED', `Téléchargement annulé pour « ${descriptor.ref} ».`, {
                ref: descriptor.ref,
                cause: error,
            });
        }
        throw new AssetError('ASSET_DOWNLOAD_FAILED', `Échec du téléchargement de « ${descriptor.ref} ».`, {
            ref: descriptor.ref,
            cause: error,
        });
    }

    if (!response.ok && response.status !== 206) {
        throw new AssetError('ASSET_DOWNLOAD_FAILED', `Réponse HTTP ${response.status} pour « ${descriptor.ref} ».`, {
            ref: descriptor.ref,
        });
    }

    const bytes = await readResponseBytes(response, descriptor.ref, options.onProgress, options.signal, partialBytes);
    const validatedBytes = partialBytes > 0 ? concatBytes(cached?.bytes ?? new Uint8Array(), bytes) : bytes;

    if (descriptor.size > 0 && validatedBytes.byteLength !== descriptor.size) {
        throw new AssetError(
            'ASSET_SIZE_MISMATCH',
            `Taille inattendue pour « ${descriptor.ref} » : ${validatedBytes.byteLength} au lieu de ${descriptor.size}.`,
            { ref: descriptor.ref },
        );
    }

    options.onProgress?.({
        ref: descriptor.ref,
        phase: 'verify',
        loadedBytes: validatedBytes.byteLength,
        totalBytes: descriptor.size,
    });

    const checksum = await sha256Hex(validatedBytes);
    if (checksum !== descriptor.sha256) {
        throw new AssetError(
            'ASSET_CHECKSUM_MISMATCH',
            `Checksum SHA-256 invalide pour « ${descriptor.ref} ».`,
            { ref: descriptor.ref },
        );
    }

    if (options.cache) {
        const cachedAsset: CachedAsset = {
            ref: descriptor.ref,
            bytes: validatedBytes,
            sha256: checksum,
            size: descriptor.size,
            downloadedAt: Date.now(),
        };
        await options.cache.set(cachedAsset);
    }

    return validatedBytes;
}

async function readResponseBytes(
    response: Response,
    ref: string,
    onProgress: DownloadAssetOptions['onProgress'],
    signal: AbortSignal | undefined,
    offset: number,
): Promise<Uint8Array> {
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        onProgress?.({ ref, phase: 'download', loadedBytes: offset + bytes.byteLength });
        return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loadedBytes = offset;

    while (true) {
        if (signal?.aborted) {
            reader.cancel().catch(() => undefined);
            throw new AssetError('ASSET_ABORTED', `Téléchargement annulé pour « ${ref} ».`, { ref });
        }

        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            loadedBytes += value.byteLength;
            onProgress?.({ ref, phase: 'download', loadedBytes });
        }
    }

    return concatBytes(...chunks);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}