import { z } from 'zod';
import type { PlatformKey } from '../lib/platform';
import { resolveProxyConfig } from './runtime';
import type { FetchLike } from './load-config';

/** Default public location of the downloads manifest. */
export const DOWNLOADS_MANIFEST_URL = '/downloads/manifest.json';

const downloadEntrySchema = z
  .object({
    file: z.string().min(1),
    url: z.string().min(1).nullable(),
    size: z.number().int().nonnegative().nullable(),
    sha256: z.string().min(1).nullable(),
    published: z.boolean(),
    signed: z.boolean().optional(),
    notarized: z.boolean().optional(),
  })
  .strict();

export const downloadsManifestSchema = z
  .object({
    version: z.string().min(1),
    wispVersion: z.number().int(),
    generatedAt: z.string().nullable(),
    platforms: z.object({
      'windows-x64': downloadEntrySchema,
      'windows-arm64': downloadEntrySchema,
      'linux-x64': downloadEntrySchema,
      'linux-arm64': downloadEntrySchema,
      macos: downloadEntrySchema,
    }),
  })
  .strict();

export type DownloadEntry = z.infer<typeof downloadEntrySchema>;
export type DownloadsManifest = z.infer<typeof downloadsManifestSchema>;

export class DownloadsManifestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DownloadsManifestError';
  }
}

/**
 * Loads the downloads manifest of the local network proxy.
 *
 * Source: `proxy.downloadManifestUrl` (config) when set, otherwise
 * `/downloads/manifest.json`. No download URL is built anywhere else: everything
 * goes through this manifest.
 */
export async function loadDownloadsManifest(
  fetchImpl: FetchLike = fetch,
): Promise<DownloadsManifest> {
  const url = resolveProxyConfig().downloadManifestUrl ?? DOWNLOADS_MANIFEST_URL;
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: 'no-store' });
  } catch (cause) {
    throw new DownloadsManifestError(`Downloads manifest not found: cannot load "${url}".`, {
      cause,
    });
  }
  if (!response.ok) {
    throw new DownloadsManifestError(
      `Downloads manifest not found: "${url}" responded ${response.status}.`,
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new DownloadsManifestError(`Downloads manifest unreadable: "${url}" is not valid JSON.`, {
      cause,
    });
  }
  const result = downloadsManifestSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new DownloadsManifestError(
      `Invalid downloads manifest: ${first?.message ?? 'unexpected structure'}.`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Resolves the download link for a platform.
 *
 * An entry is downloadable only when `published === true` AND `url` is not
 * null; otherwise `null` (the UI then shows "Unavailable").
 */
export function resolveDownloadUrl(manifest: DownloadsManifest, key: PlatformKey): string | null {
  const entry = manifest.platforms[key];
  if (!entry.published) return null;
  if (entry.url === null || entry.url.length === 0) return null;
  return entry.url;
}

/** Every target in the manifest, in a stable display order. */
export function listDownloadTargets(manifest: DownloadsManifest): Array<{
  key: PlatformKey;
  entry: DownloadEntry;
  url: string | null;
}> {
  const order: PlatformKey[] = [
    'windows-x64',
    'windows-arm64',
    'linux-x64',
    'linux-arm64',
    'macos',
  ];
  return order.map((key) => ({
    key,
    entry: manifest.platforms[key],
    url: resolveDownloadUrl(manifest, key),
  }));
}
