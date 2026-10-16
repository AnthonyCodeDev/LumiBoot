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
 * Taille maximale acceptée pour un média disque importé (64 Gio). Le média
 * reste dans le navigateur de l'utilisateur : cette borne évite de saturer le
 * quota de stockage local, elle ne présume rien du contenu.
 */
export const MAX_USER_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;

/** Extensions reconnues, associées au format disque attendu par v86. */
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

/** Déduit le format du média depuis l'extension ; inconnu -> disque brut. */
export function detectMediaFormat(fileName: string): VMMediaFormat {
  return fileName.toLowerCase().endsWith('.iso') ? 'iso' : 'raw';
}

/** Format réellement accepté pour ce nom de fichier, ou `null` si inconnu. */
export function mediaFormatForFile(fileName: string): VMMediaFormat | null {
  const lower = fileName.toLowerCase();
  return EXTENSION_FORMATS.find((entry) => lower.endsWith(entry.extension))?.format ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} Gio`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mio`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${bytes} octets`;
}

/**
 * Valide un fichier média AVANT tout import : extension reconnue, format disque
 * déductible, taille non nulle et sous le plafond. Lève un `AssetError` explicite
 * (message utilisateur clair), jamais une erreur anonyme.
 */
export function validateUserMediaFile(file: FileLike): { format: VMMediaFormat } {
  const format = mediaFormatForFile(file.name);
  if (format === null) {
    throw new AssetError(
      'ASSET_IMPORT_REJECTED',
      `Format non reconnu pour « ${file.name} ». Extensions acceptées : ${USER_MEDIA_EXTENSIONS.join(
        ', ',
      )}.`,
    );
  }
  if (file.size <= 0) {
    throw new AssetError('ASSET_IMPORT_REJECTED', `Le fichier « ${file.name} » est vide.`);
  }
  if (file.size > MAX_USER_MEDIA_BYTES) {
    throw new AssetError(
      'ASSET_IMPORT_REJECTED',
      `« ${file.name} » (${formatBytes(file.size)}) dépasse la taille maximale autorisée (${formatBytes(
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
 * Quota de stockage restant, ou `null` si l'API n'est pas exploitable. Ne lève
 * jamais : l'absence d'estimation ne doit pas bloquer un import légitime.
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
 * Vérifie que le média tient dans le quota de stockage local. Rejette avec un
 * message actionnable si l'espace restant est insuffisant.
 */
export async function assertUserMediaFitsQuota(file: FileLike): Promise<void> {
  const remaining = await getRemainingQuotaBytes();
  if (remaining === null) return;
  if (remaining < file.size) {
    throw new AssetError(
      'ASSET_CACHE_QUOTA_EXCEEDED',
      `Espace de stockage insuffisant pour « ${file.name} » : ${formatBytes(
        file.size,
      )} requis, ${formatBytes(Math.max(remaining, 0))} disponible. Libérez des médias importés puis réessayez.`,
    );
  }
}

function parseManifestJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AssetError(
      'ASSET_INVALID_MANIFEST',
      'Manifeste utilisateur illisible : JSON invalide.',
    );
  }
}

export interface UserMediaState {
  /** Médias importés, indexés par identifiant système. */
  records: Record<string, UserMediaDescriptor>;
  loading: boolean;
  importing: boolean;
  error: string | undefined;
  load: () => Promise<void>;
  /**
   * Importe le média d'un système. `licenseAcknowledged` est transmis TEL QUEL
   * à `vm-assets` : l'attestation de licence est une contrainte du domaine, pas
   * seulement une case de l'interface.
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
 * Store front-end des médias importés. Il ne fait que relayer `vm-assets` et le
 * store de persistance : aucune logique d'émulation ici, et **aucun upload** —
 * le média de l'utilisateur ne quitte jamais son navigateur (IndexedDB/OPFS).
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
          'Import refusé : vous devez attester détenir une licence et le droit d’usage de ce média.',
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
            `Manifeste incohérent : référence « ${declared.ref} » au lieu de « ${system.id} ».`,
          );
        }
        if (declared.format !== format) {
          throw new AssetError(
            'ASSET_INVALID_MANIFEST',
            `Manifeste incohérent : format « ${declared.format} » au lieu de « ${format} » pour « ${media.name} ».`,
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
