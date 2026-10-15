import { create } from 'zustand';
import type { CompanionState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';
import { resolveCompanionConfig } from '../../config/runtime';
import { checkCompanion } from './detect';
import {
  CompanionPairingError,
  exchangeToken,
  getPairingStatus,
  requestPairing,
  revokeSession,
} from './pairing';

export interface CompanionStoreState {
  /** État réel : `connected` exige `/health` OK **et** un token obtenu. */
  state: CompanionState;
  /** Jeton de session : mémoire uniquement, jamais persisté. */
  token: string | null;
  pairingId: string | null;
  userCode: string | null;
  error: string | null;
  refresh: (fetchImpl?: FetchLike) => Promise<void>;
  startPairing: (fetchImpl?: FetchLike) => Promise<void>;
  connect: (pairingId?: string, fetchImpl?: FetchLike) => Promise<void>;
  revoke: (fetchImpl?: FetchLike) => Promise<void>;
  dismissError: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof CompanionPairingError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Erreur inattendue du compagnon.';
}

/**
 * Store compagnon (mémoire uniquement).
 *
 * Garantie : `connected` n'est déclaré qu'après une vraie réponse `/health`
 * (`wispVersion` compatible) **et** un token obtenu par `exchangeToken`.
 * Un `/health` OK sans token donne `pairing-required` (compagnon joint mais
 * pas appairé). Le token n'est jamais écrit dans `localStorage`.
 */
export const useCompanionStore = create<CompanionStoreState>((set, get) => ({
  state: 'not-running',
  token: null,
  pairingId: null,
  userCode: null,
  error: null,

  refresh: async (fetchImpl: FetchLike = fetch) => {
    const { url } = resolveCompanionConfig();
    const health = await checkCompanion(url, fetchImpl);
    if (health.state !== 'connected') {
      set({ state: health.state, error: null });
      return;
    }
    if (get().token) {
      set({ state: 'connected', error: null });
    } else {
      set({ state: 'pairing-required', error: null });
    }
  },

  startPairing: async (fetchImpl: FetchLike = fetch) => {
    set({ state: 'connecting', error: null });
    const { url } = resolveCompanionConfig();
    try {
      const { pairingId, userCode } = await requestPairing(url, fetchImpl);
      set({ pairingId, userCode, state: 'pairing-required', error: null });
    } catch (error) {
      set({ state: 'error', error: messageOf(error) });
    }
  },

  connect: async (pairingId?: string, fetchImpl: FetchLike = fetch) => {
    const id = pairingId ?? get().pairingId;
    if (!id) {
      set({ state: 'error', error: 'Aucune demande d’appairage en cours : lancez l’appairage.' });
      return;
    }
    const { url } = resolveCompanionConfig();
    try {
      const status = await getPairingStatus(url, id, fetchImpl);
      if (status.status === 'denied') {
        set({
          state: 'error',
          error: 'Appairage refusé depuis la page d’admin locale du compagnon.',
        });
        return;
      }
      if (status.status === 'pending') {
        set({
          state: 'pairing-required',
          error: 'En attente d’approbation : validez le code depuis la page d’admin locale.',
        });
        return;
      }
      const { token } = await exchangeToken(url, id, fetchImpl);
      // Le token est obtenu : on re-sonde `/health` avant d'affirmer `connected`.
      const health = await checkCompanion(url, fetchImpl);
      if (health.state !== 'connected') {
        set({ token, state: health.state, error: null });
        return;
      }
      set({ token, pairingId: null, state: 'connected', error: null });
    } catch (error) {
      set({ state: 'error', error: messageOf(error) });
    }
  },

  revoke: async (fetchImpl: FetchLike = fetch) => {
    const { token } = get();
    const { url } = resolveCompanionConfig();
    if (token) {
      try {
        await revokeSession(url, token, fetchImpl);
      } catch (error) {
        set({ state: 'error', error: messageOf(error) });
        return;
      }
    }
    set({ token: null, pairingId: null, userCode: null, error: null });
    const health = await checkCompanion(url, fetchImpl);
    set({ state: health.state === 'connected' ? 'pairing-required' : health.state });
  },

  dismissError: () => {
    set({ error: null });
  },
}));

/** Jeton runtime pour le profil réseau de la session (jamais persisté). */
export function getCompanionRuntimeCredentials(): {
  companionUrl: string;
  companionToken: string | null;
} {
  const { url } = resolveCompanionConfig();
  const token = useCompanionStore.getState().token;
  return { companionUrl: url, companionToken: token };
}
