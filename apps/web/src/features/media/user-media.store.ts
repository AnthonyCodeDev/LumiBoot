import { create } from 'zustand';
import type { OSDefinition, VMMediaFormat } from '@lumiboot/contracts';
import {
  AssetError,
  importUserMedia,
  parseUserMediaManifest,
  type UserMediaDescriptor,
} from '@lumiboot/vm-assets';
import { toUserMessage } from '../../lib/errors';
import { getUserMediaStore } from './user-media.storage';

/** Maximum accepted size for an imported disk media: 64 GiB. */
export const MAX_USER_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;

/** A blocked IndexedDB open never resolves: the UI must not stay on `loading`. */
export const USER_MEDIA_LOAD_TIMEOUT_MS = 10_000;

export const USER_MEDIA_EXTENSIONS = ['.iso', '.img', '.raw'] as const;

const EXTENSION_FORMATS: ReadonlyArray<{ extension: string; format: VMMediaFormat }> = [
  { extension: '.iso', format: 'iso' },
  { extension: '.img', format: 'raw' },
  { extension: '.raw', format: 'raw' },
];

interface FileLike {
  readonly name: string;
  readonly size: number;
}

export function detectMediaFormat(fileName: string): VMMediaFormat {
  return fileName.toLowerCase().endsWith('.iso') ? 'iso' : 'raw';
}

/** `null` when the extension is unknown. */
export function mediaFormatForFile(fileName: string): VMMediaFormat | null {
  const lower = fileName.toLowerCase();
  return EXTENSION_FORMATS.find((entry) => lower.endsWith(entry.extension))?.format ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

export function validateUserMediaFile(file: FileLike): { format: VMMediaFormat } {
  const format = mediaFormatForFile(file.name);
  if (format === null) {
    throw new AssetError(
      'ASSET_IMPORT_REJECTED',
      `Unrecognized format for "${file.name}". Accepted extensions: ${USER_MEDIA_EXTENSIONS.join(
        ', ',
      )}.`,
    );
  }
  if (file.size <= 0) {
    throw new AssetError('ASSET_IMPORT_REJECTED', `The file "${file.name}" is empty.`);
  }
  if (file.size > MAX_USER_MEDIA_BYTES) {
    throw new AssetError(
      'ASSET_IMPORT_REJECTED',
      `"${file.name}" (${formatBytes(file.size)}) exceeds the maximum allowed size (${formatBytes(
        MAX_USER_MEDIA_BYTES,
      )}).`,
    );
  }
  return { format };
}

interface StorageEstimateLike {
  quota?: number;
  usage?: number;
}

/** Remaining storage quota, or `null` when unavailable. Never throws. */
async function getRemainingQuotaBytes(): Promise<number | null> {
  const storage =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { storage?: { estimate?: () => Promise<StorageEstimateLike> } })
          .storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const { quota, usage } = await storage.estimate();
    if (typeof quota !== 'number' || typeof usage !== 'number') return null;
    return quota - usage;
  } catch {
    return null;
  }
}

export async function assertUserMediaFitsQuota(file: FileLike): Promise<void> {
  const remaining = await getRemainingQuotaBytes();
  if (remaining === null) return;
  if (remaining < file.size) {
    throw new AssetError(
      'ASSET_CACHE_QUOTA_EXCEEDED',
      `Not enough storage for "${file.name}": ${formatBytes(
        file.size,
      )} required, ${formatBytes(Math.max(remaining, 0))} available. Remove imported media and try again.`,
    );
  }
}

function parseManifestJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AssetError('ASSET_INVALID_MANIFEST', 'Unreadable user manifest: invalid JSON.');
  }
}

export interface UserMediaState {
  /** Indexed by system ID. */
  records: Record<string, UserMediaDescriptor>;
  loading: boolean;
  importing: boolean;
  error: string | undefined;
  load: () => Promise<void>;
  importFor: (
    system: OSDefinition,
    media: File,
    licenseAcknowledged: boolean,
    manifest?: File,
  ) => Promise<void>;
  remove: (ref: string) => Promise<void>;
}

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = USER_MEDIA_LOAD_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const useUserMediaStore = create<UserMediaState>((set) => ({
  records: {},
  loading: false,
  importing: false,
  error: undefined,
  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const descriptors = await withTimeout(
        (async () => {
          const store = await getUserMediaStore();
          return store.list();
        })(),
        'Reading local media storage timed out. Close other LumiBoot tabs and retry.',
      );
      const records: Record<string, UserMediaDescriptor> = {};
      for (const descriptor of descriptors) records[descriptor.ref] = descriptor;
      set({ records, loading: false });
    } catch (error) {
      set({ loading: false, error: toUserMessage(error) });
    }
  },
  importFor: async (system, media, licenseAcknowledged, manifest) => {
    set({ importing: true, error: undefined });
    try {
      if (!licenseAcknowledged) {
        throw new AssetError(
          'ASSET_IMPORT_REJECTED',
          'Import refused: you must confirm that you hold a license and the right to use this media.',
        );
      }
      const { format } = validateUserMediaFile(media);
      await assertUserMediaFitsQuota(media);

      const declared = manifest
        ? parseUserMediaManifest(parseManifestJson(await manifest.text()))
        : null;
      if (declared) {
        if (declared.ref !== system.id) {
          throw new AssetError(
            'ASSET_INVALID_MANIFEST',
            `Inconsistent manifest: reference "${declared.ref}" instead of "${system.id}".`,
          );
        }
        if (declared.format !== format) {
          throw new AssetError(
            'ASSET_INVALID_MANIFEST',
            `Inconsistent manifest: format "${declared.format}" instead of "${format}" for "${media.name}".`,
          );
        }
      }

      const store = await getUserMediaStore();
      const descriptor = await importUserMedia(
        store,
        {
          ref: system.id,
          displayName: `${system.displayName} ${system.versionLabel}`.trim(),
          fileName: media.name,
          format,
          licenseAcknowledged,
        },
        media,
        {
          ...(declared?.sha256 === undefined ? {} : { expectedSha256: declared.sha256 }),
          ...(declared?.sizeBytes === undefined ? {} : { expectedSize: declared.sizeBytes }),
        },
      );
      set((state) => ({
        records: { ...state.records, [descriptor.ref]: descriptor },
        importing: false,
      }));
    } catch (error) {
      set({ importing: false, error: toUserMessage(error) });
      throw error;
    }
  },
  remove: async (ref) => {
    try {
      const store = await getUserMediaStore();
      await store.remove(ref);
      set((state) => {
        const records = { ...state.records };
        delete records[ref];
        return { records };
      });
    } catch (error) {
      set({ error: toUserMessage(error) });
    }
  },
}));
