import { z } from 'zod';
import type { PlatformKey } from '../lib/platform';
import { resolveProxyConfig } from './runtime';
import type { FetchLike } from './load-config';
import { readEnv, sameOriginPath } from './environment';

export const DOWNLOADS_MANIFEST_URL = sameOriginPath(
  readEnv('VITE_DOWNLOADS_MANIFEST_URL', '/downloads/manifest.json'),
  '/downloads/manifest.json',
);

/** A compromised manifest must not point at a third-party binary: same-origin paths only. */
function isSafeDownloadUrl(value: string): boolean {
  if (value.length === 0) return false;
  if (/\s/.test(value)) return false;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return false;
  try {
    const base = 'https://lumiboot.invalid';
    return new URL(value, base).origin === base;
  } catch {
    return false;
  }
}

/** A SHA-256 digest, lowercase or uppercase hex. */
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

const downloadEntrySchema = z
  .object({
    file: z.string().min(1),
    url: z.string().refine(isSafeDownloadUrl, 'Unsafe download URL.').nullable(),
    size: z.number().int().nonnegative().nullable(),
    sha256: z.string().regex(SHA256_PATTERN, 'Invalid SHA-256 digest.').nullable(),
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
    platforms: z
      .object({
        'windows-x64': downloadEntrySchema,
        'windows-arm64': downloadEntrySchema,
        'linux-x64': downloadEntrySchema,
        'linux-arm64': downloadEntrySchema,
        macos: downloadEntrySchema,
      })
      .strict(),
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

/** Loads the proxy downloads manifest. Every download URL comes from it. */
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

/** Only published entries with a safe `url`, a positive `size` and a SHA-256 digest are links. */
export function resolveDownloadUrl(manifest: DownloadsManifest, key: PlatformKey): string | null {
  const entry = manifest.platforms[key];
  if (!entry.published) return null;
  if (entry.url === null || entry.url.length === 0) return null;
  // Keep this guard for manifests supplied directly to components in tests or embeds.
  if (!isSafeDownloadUrl(entry.url)) return null;
  if (entry.size === null || !Number.isInteger(entry.size) || entry.size <= 0) return null;
  if (entry.sha256 === null || !SHA256_PATTERN.test(entry.sha256)) return null;
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
