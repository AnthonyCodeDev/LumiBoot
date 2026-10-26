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

/**
 * Maximum accepted size for an imported disk media (64 GiB). The media stays in
 * the user's browser: this bound avoids saturating the local storage quota and
 * assumes nothing about the content.
 */
export const MAX_USER_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;

/** Recognized extensions, mapped to the disk format v86 expects. */
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

/** Infers the media format from the extension; unknown -> raw disk. */
export function detectMediaFormat(fileName: string): VMMediaFormat {
  return fileName.toLowerCase().endsWith('.iso') ? 'iso' : 'raw';
}

/** Format actually accepted for this file name, or `null` when unknown. */
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

/**
 * Validates a media file BEFORE any import: recognized extension, inferable disk
 * format, non-zero size under the cap. Throws an explicit `AssetError` (clear
 * user message), never an anonymous error.
 */
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

/**
 * Remaining storage quota, or `null` when the API cannot be used. Never throws:
 * a missing estimate must not block a legitimate import.
 */
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

/**
 * Checks that the media fits in the local storage quota. Rejects with an
 * actionable message when the remaining space is insufficient.
 */
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
  /** Imported media, indexed by system ID. */
  records: Record<string, UserMediaDescriptor>;
  loading: boolean;
  importing: boolean;
  error: string | undefined;
  load: () => Promise<void>;
  /**
   * Imports the media of a system. `licenseAcknowledged` is forwarded AS-IS to
   * `vm-assets`: the license confirmation is a domain constraint, not just a UI
   * checkbox.
   */
  importFor: (
    system: OSDefinition,
    media: File,
    licenseAcknowledged: boolean,
    manifest?: File,
  ) => Promise<void>;
  remove: (ref: string) => Promise<void>;
}

/**
 * Front-end store for imported media. It only relays `vm-assets` and the
 * persistence store: no emulation logic here, and **no upload** — the user media
 * never leaves their browser (IndexedDB/OPFS).
 */
export const useUserMediaStore = create<UserMediaState>((set) => ({
  records: {},
  loading: false,
  importing: false,
  error: undefined,
  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const store = await getUserMediaStore();
      const descriptors = await store.list();
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
