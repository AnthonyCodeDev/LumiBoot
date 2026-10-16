import { create } from 'zustand';
import type { OSDefinition, VMMediaFormat } from '@lumiboot/contracts';
import {
  importUserMedia,
  parseUserMediaManifest,
  type UserMediaDescriptor,
} from '@lumiboot/vm-assets';
import { toUserMessage } from '../../lib/errors';
import { getUserMediaStore } from './user-media.storage';

/** Déduit le format du média depuis l'extension ; inconnu -> disque brut. */
export function detectMediaFormat(fileName: string): VMMediaFormat {
  return fileName.toLowerCase().endsWith('.iso') ? 'iso' : 'raw';
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
 * store de persistance : aucune logique d'émulation ici.
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
      const store = await getUserMediaStore();
      const declared = manifest ? parseUserMediaManifest(JSON.parse(await manifest.text())) : null;
      const descriptor = await importUserMedia(
        store,
        {
          ref: system.id,
          displayName: `${system.displayName} ${system.versionLabel}`.trim(),
          fileName: media.name,
          format: detectMediaFormat(media.name),
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
