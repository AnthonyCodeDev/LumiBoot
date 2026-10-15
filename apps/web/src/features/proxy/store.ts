import { create } from 'zustand';
import type { ProxyState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';
import { resolveProxyConfig } from '../../config/runtime';
import { checkProxy } from './detect';
import {
  clearProxySession,
  loadProxySession,
  saveProxySession,
} from './persistence';
import {
  ProxyPairingError,
  exchangeToken,
  getPairingStatus,
  requestPairing,
  revokeSession,
} from './pairing';

/** Intervalle de surveillance de l'approbation d'appairage (auto-connexion). */
export const PAIRING_POLL_INTERVAL_MS = 1500;

export interface ProxyStoreState {
  /** État réel : `connected` exige `/health` OK **et** un token obtenu. */
  state: ProxyState;
  /** Jeton de session en mémoire (source de vérité runtime). */
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
  if (error instanceof ProxyPairingError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Erreur inattendue du proxy réseau local.';
}

/** Intervalle actif de surveillance d'appairage (au plus un à la fois). */
let pairingPollTimer: ReturnType<typeof setInterval> | null = null;
/** Empêche deux interrogations de statut de se chevaucher. */
let pairingPollInFlight = false;

/** Arrête la surveillance d'appairage si elle est active. Idempotent. */
function stopPairingPolling(): void {
  pairingPollInFlight = false;
  if (pairingPollTimer !== null) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
}

/**
 * Échange un appairage approuvé contre un jeton puis revérifie `/health`
 * avant de déclarer `connected`. Logique partagée par `connect()` et
 * l'auto-connexion.
 */
async function completeConnection(
  url: string,
  pairingId: string,
  fetchImpl: FetchLike,
): Promise<void> {
  const { token, expiresAt } = await exchangeToken(url, pairingId, fetchImpl);
  // Persiste le jeton pour survivre à un rechargement de page (F5).
  saveProxySession({ token, expiresAt, proxyUrl: url });
  // Le token est obtenu : on re-sonde `/health` avant d'affirmer `connected`.
  const health = await checkProxy(url, fetchImpl);
  if (health.state !== 'connected') {
    useProxyStore.setState({ token, state: health.state, error: null });
    return;
  }
  useProxyStore.setState({ token, pairingId: null, state: 'connected', error: null });
}

/**
 * Surveille `getPairingStatus` jusqu'à l'approbation. Dès que le proxy réseau local
 * approuve, échange le jeton et passe à `connected` sans clic. S'arrête sur
 * `denied`, erreur, expiration ou 404.
 */
function beginPairingPolling(url: string, pairingId: string, fetchImpl: FetchLike): void {
  stopPairingPolling();
  pairingPollTimer = setInterval(() => {
    if (pairingPollInFlight) return;
    pairingPollInFlight = true;
    void (async () => {
      try {
        const status = await getPairingStatus(url, pairingId, fetchImpl);
        if (status.status === 'approved') {
          stopPairingPolling();
          await completeConnection(url, pairingId, fetchImpl);
          return;
        }
        if (status.status === 'denied') {
          stopPairingPolling();
          useProxyStore.setState({
            state: 'error',
            error: 'Accès refusé depuis la console du proxy.',
          });
        }
      } catch (error) {
        stopPairingPolling();
        useProxyStore.setState({ state: 'error', error: messageOf(error) });
      } finally {
        pairingPollInFlight = false;
      }
    })();
  }, PAIRING_POLL_INTERVAL_MS);
}

/**
 * Store proxy réseau local.
 *
 * Garantie : `connected` n'est déclaré qu'après une vraie réponse `/health`
 * (`wispVersion` compatible) **et** un token obtenu par `exchangeToken` (ou
 * restauré depuis le stockage, revérifié par `/health`). Un `/health` OK sans
 * token donne `pairing-required` (proxy réseau local joint mais pas appairé).
 *
 * Persistance : le token de session est conservé dans `localStorage`
 * (`lumiboot.proxy.session`) afin de survivre à un rechargement de page
 * (F5), au lieu de retomber en `pairing-required`. Compromis sécurité assumé :
 * le token est **loopback uniquement**, **lié à l'origine** LumiBoot, à **TTL**
 * (expiration vérifiée à la relecture) et **révocable** ; il est **supprimé à
 * la révocation ou à l'expiration**. Le risque XSS est circonscrit à l'origine
 * qui sert LumiBoot. `getProxyRuntimeCredentials()` continue de lire le
 * token mémoire, jamais le stockage.
 */
export const useProxyStore = create<ProxyStoreState>((set, get) => ({
  state: 'not-running',
  token: null,
  pairingId: null,
  userCode: null,
  error: null,

  refresh: async (fetchImpl: FetchLike = fetch) => {
    const { url } = resolveProxyConfig();
    const health = await checkProxy(url, fetchImpl);
    if (health.state !== 'connected') {
      set({ state: health.state, error: null });
      return;
    }
    if (get().token) {
      set({ state: 'connected', error: null });
      return;
    }
    // Aucun token mémoire : tenter une restauration persistée (survie au F5).
    // Le jeton restauré n'est accepté que parce que `/health` répond déjà.
    const restored = loadProxySession(url);
    if (restored) {
      set({ token: restored.token, state: 'connected', error: null });
      return;
    }
    set({ state: 'pairing-required', error: null });
  },

  startPairing: async (fetchImpl: FetchLike = fetch) => {
    stopPairingPolling();
    set({ state: 'connecting', error: null });
    const { url } = resolveProxyConfig();
    try {
      const { pairingId, userCode } = await requestPairing(url, fetchImpl);
      set({ pairingId, userCode, state: 'pairing-required', error: null });
      // Auto-connexion : on surveille l'approbation côté console du proxy.
      beginPairingPolling(url, pairingId, fetchImpl);
    } catch (error) {
      stopPairingPolling();
      set({ state: 'error', error: messageOf(error) });
    }
  },

  connect: async (pairingId?: string, fetchImpl: FetchLike = fetch) => {
    const id = pairingId ?? get().pairingId;
    if (!id) {
      set({ state: 'error', error: 'Aucune demande d’appairage en cours : lancez l’appairage.' });
      return;
    }
    // Repli manuel : on prend la main sur l'auto-connexion.
    stopPairingPolling();
    const { url } = resolveProxyConfig();
    try {
      const status = await getPairingStatus(url, id, fetchImpl);
      if (status.status === 'denied') {
        set({
          state: 'error',
          error: 'Accès refusé depuis la console du proxy.',
        });
        return;
      }
      if (status.status === 'pending') {
        set({
          state: 'pairing-required',
          error: 'En attente d’autorisation : validez le code depuis la console du proxy.',
        });
        // Reprend la surveillance pour finir l'appairage sans nouveau clic.
        beginPairingPolling(url, id, fetchImpl);
        return;
      }
      await completeConnection(url, id, fetchImpl);
    } catch (error) {
      set({ state: 'error', error: messageOf(error) });
    }
  },

  revoke: async (fetchImpl: FetchLike = fetch) => {
    stopPairingPolling();
    const { token } = get();
    const { url } = resolveProxyConfig();
    if (token) {
      try {
        await revokeSession(url, token, fetchImpl);
      } catch (error) {
        set({ state: 'error', error: messageOf(error) });
        return;
      }
    }
    clearProxySession();
    set({ token: null, pairingId: null, userCode: null, error: null });
    const health = await checkProxy(url, fetchImpl);
    set({ state: health.state === 'connected' ? 'pairing-required' : health.state });
  },

  dismissError: () => {
    stopPairingPolling();
    set({ error: null });
  },
}));

/** Jeton runtime pour le profil réseau de la session (lu en mémoire). */
export function getProxyRuntimeCredentials(): {
  proxyUrl: string;
  proxyToken: string | null;
} {
  const { url } = resolveProxyConfig();
  const token = useProxyStore.getState().token;
  return { proxyUrl: url, proxyToken: token };
}
