import { sha256Hex } from './hash';
import type { AssetCache, CachedAsset } from './cache';
import { AssetError } from './errors';

export interface AssetDescriptor {
  readonly ref: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly version?: string;
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
  readonly chunkSizeBytes?: number;
  readonly onProgress?: (progress: AssetDownloadProgress) => void;
}

export async function downloadAsset(
  descriptor: AssetDescriptor,
  options: DownloadAssetOptions = {},
): Promise<Uint8Array> {
  const cached = options.cache ? await options.cache.get(descriptor.ref) : null;
  const cacheVersionMatches =
    cached !== null && cached.size === descriptor.size && cached.version === descriptor.version;
  if (
    cacheVersionMatches &&
    cached.sha256 === descriptor.sha256 &&
    cached.bytes.byteLength === descriptor.size
  ) {
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
    throw new AssetError('ASSET_DOWNLOAD_FAILED', 'No HTTP client is available.', {
      ref: descriptor.ref,
    });
  }

  const chunkSizeBytes = options.chunkSizeBytes ?? 4 * 1024 * 1024;
  const canResume =
    options.allowResume &&
    cacheVersionMatches &&
    cached.bytes.byteLength > 0 &&
    cached.bytes.byteLength < descriptor.size;
  const partialBytes = canResume ? cached.bytes.byteLength : 0;

  let validatedBytes: Uint8Array;
  if (descriptor.size > 0) {
    validatedBytes = await downloadAssetInChunks(descriptor, {
      fetchImpl,
      signal: options.signal,
      onProgress: options.onProgress,
      chunkSizeBytes,
      partialBytes,
      cachedBytes: partialBytes > 0 ? (cached?.bytes ?? null) : null,
    });
  } else {
    const response = await fetchAsset(descriptor.url, fetchImpl, options.signal, 0);
    if (!response.ok && response.status !== 206) {
      throw new AssetError(
        'ASSET_DOWNLOAD_FAILED',
        `HTTP response ${response.status} for "${descriptor.ref}".`,
        {
          ref: descriptor.ref,
        },
      );
    }
    validatedBytes = await readResponseBytes(
      response,
      descriptor.ref,
      options.onProgress,
      options.signal,
      0,
    );
  }

  if (descriptor.size > 0 && validatedBytes.byteLength !== descriptor.size) {
    throw new AssetError(
      'ASSET_SIZE_MISMATCH',
      `Unexpected size for "${descriptor.ref}": ${validatedBytes.byteLength} instead of ${descriptor.size}.`,
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
      `Invalid SHA-256 checksum for "${descriptor.ref}".`,
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
      ...(descriptor.version !== undefined ? { version: descriptor.version } : {}),
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
      throw new AssetError('ASSET_ABORTED', `Download canceled for "${ref}".`, { ref });
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

async function downloadAssetInChunks(
  descriptor: AssetDescriptor,
  options: {
    fetchImpl: typeof fetch;
    signal: AbortSignal | undefined;
    onProgress: DownloadAssetOptions['onProgress'];
    chunkSizeBytes: number;
    partialBytes: number;
    cachedBytes: Uint8Array | null;
  },
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  if (options.cachedBytes) chunks.push(options.cachedBytes);

  let downloadedBytes = options.partialBytes;
  if (options.partialBytes > 0) {
    options.onProgress?.({
      ref: descriptor.ref,
      phase: 'resume',
      loadedBytes: options.partialBytes,
      totalBytes: descriptor.size,
    });
  }

  while (downloadedBytes < descriptor.size) {
    const end = Math.min(downloadedBytes + options.chunkSizeBytes - 1, descriptor.size - 1);
    const response = await fetchAsset(
      descriptor.url,
      options.fetchImpl,
      options.signal,
      downloadedBytes,
      end,
    );
    const chunk = await readRangeChunk(
      response,
      descriptor,
      downloadedBytes,
      end,
      options.signal,
      options.onProgress,
    );
    chunks.push(chunk);
    downloadedBytes += chunk.byteLength;
  }

  return concatBytes(...chunks);
}

async function fetchAsset(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  start: number,
  end?: number,
): Promise<Response> {
  const headers =
    start > 0 || end !== undefined ? { Range: `bytes=${start}-${end ?? ''}` } : undefined;

  try {
    return await fetchImpl(url, {
      ...(headers !== undefined ? { headers } : {}),
      signal: signal ?? null,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AssetError('ASSET_ABORTED', `Download canceled.`, { cause: error });
    }
    throw new AssetError('ASSET_DOWNLOAD_FAILED', `Failed to download "${url}".`, {
      cause: error,
    });
  }
}

async function readRangeChunk(
  response: Response,
  descriptor: AssetDescriptor,
  start: number,
  end: number,
  signal: AbortSignal | undefined,
  onProgress: DownloadAssetOptions['onProgress'],
): Promise<Uint8Array> {
  if (start === 0 && response.status === 200) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({
      ref: descriptor.ref,
      phase: 'download',
      loadedBytes: bytes.byteLength,
      totalBytes: descriptor.size,
    });
    return bytes;
  }

  if (response.status !== 206) {
    throw new AssetError(
      'ASSET_DOWNLOAD_FAILED',
      `HTTP response ${response.status} for "${descriptor.ref}".`,
      {
        ref: descriptor.ref,
      },
    );
  }

  const contentRange = response.headers.get('Content-Range');
  if (!contentRange) {
    throw new AssetError(
      'ASSET_DOWNLOAD_FAILED',
      `Missing Content-Range for "${descriptor.ref}".`,
      {
        ref: descriptor.ref,
      },
    );
  }

  const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
  if (!rangeMatch) {
    throw new AssetError(
      'ASSET_DOWNLOAD_FAILED',
      `Invalid Content-Range for "${descriptor.ref}".`,
      {
        ref: descriptor.ref,
      },
    );
  }

  const rangeStart = Number(rangeMatch[1]);
  const rangeEnd = Number(rangeMatch[2]);
  const rangeTotal = rangeMatch[3] === '*' ? descriptor.size : Number(rangeMatch[3]);

  if (rangeStart !== start || rangeEnd !== end || rangeTotal !== descriptor.size) {
    throw new AssetError(
      'ASSET_DOWNLOAD_FAILED',
      `Incompatible Content-Range for "${descriptor.ref}".`,
      {
        ref: descriptor.ref,
      },
    );
  }

  return readResponseBytes(response, descriptor.ref, onProgress, signal, start);
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
