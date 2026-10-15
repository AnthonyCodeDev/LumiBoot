import { create } from 'zustand';
import type { ProxyState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';
import { resolveProxyConfig } from '../../config/runtime';
import { checkProxy } from './detect';
import { clearProxySession, loadProxySession, saveProxySession } from './persistence';
import {
  ProxyPairingError,
  exchangeToken,
  getPairingStatus,
  requestPairing,
  revokeSession,
  verifyToken,
  type VerifyTokenResult,
} from './pairing';

/** Intervalle de surveillance de l'approbation d'appairage (auto-connexion). */
export const PAIRING_POLL_INTERVAL_MS = 1500;

export interface ProxyStoreState {
  /**
   * État réel : `connected` exige `/health` OK **et** une vérification
   * authentifiée du jeton (`verifyToken`) réussie.
   */
  state: ProxyState;
  /** `/health` a répondu (proxy réseau local joignable). Nécessaire, pas suffisant. */
  reachable: boolean;
  /** Le jeton a été réellement validé par le proxy (vérification authentifiée). */
  authenticated: boolean;
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
  /** Annule toute surveillance d'appairage en cours (ex. démontage du composant). */
  cancelPairing: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof ProxyPairingError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Erreur inattendue du proxy réseau local.';
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** Intervalle actif de surveillance d'appairage (au plus un à la fois). */
let pairingPollTimer: ReturnType<typeof setInterval> | null = null;
/** Empêche deux interrogations de statut de se chevaucher. */
let pairingPollInFlight = false;
/**
 * Génération de surveillance : incrémentée à chaque annulation/redémarrage.
 * Toute réponse d'une génération obsolète est ignorée (réduction des courses).
 */
let pairingPollGeneration = 0;
/** `AbortController` du poll courant : annule la requête réseau en vol. */
let pairingPollAbort: AbortController | null = null;
/** URL sur laquelle porte le poll courant (détection de changement d'URL). */
let pairingPollUrl: string | null = null;

/**
 * Arrête la surveillance d'appairage si elle est active. Idempotent.
 * Invalide la génération courante : les réponses déjà en vol seront ignorées.
 */
function cancelPairingPolling(): void {
  pairingPollGeneration += 1;
  pairingPollInFlight = false;
  pairingPollUrl = null;
  if (pairingPollAbort !== null) {
    try {
      pairingPollAbort.abort();
    } catch {
      // `abort()` ne doit jamais faire échouer l'annulation.
    }
    pairingPollAbort = null;
  }
  if (pairingPollTimer !== null) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
}

/**
 * Échange un appairage approuvé contre un jeton, puis **vérifie**
 * authentiquement ce jeton avant d'affirmer `connected`. `generation` empêche
 * qu'une connexion tardive écrase un état plus récent (révocation, nouvel
 * essai…).
 */
async function completeConnection(
  url: string,
  pairingId: string,
  fetchImpl: FetchLike,
  generation: number,
): Promise<void> {
  const { token, expiresAt } = await exchangeToken(url, pairingId, fetchImpl);
  if (generation !== pairingPollGeneration) return;
  // `/health` d'abord : le proxy doit être joignable…
  const health = await checkProxy(url, fetchImpl);
  if (generation !== pairingPollGeneration) return;
  if (health.state !== 'connected') {
    useProxyStore.setState({
      token,
      state: health.state,
      reachable: false,
      authenticated: false,
      error: health.error ?? null,
    });
    return;
  }
  // …puis le jeton doit être réellement validé (vérification authentifiée).
  const verification = await verifyToken(url, token, fetchImpl);
  if (generation !== pairingPollGeneration) return;
  if (!verification.ok) {
    // Jeton refusé : on ne persiste rien et on repasse en appairage.
    clearProxySession();
    useProxyStore.setState({
      token: null,
      state: 'pairing-required',
      reachable: true,
      authenticated: false,
      error: null,
    });
    return;
  }
  // Le jeton n'est persisté qu'après validation authentifiée.
  saveProxySession({ token, expiresAt, proxyUrl: url });
  useProxyStore.setState({
    token,
    pairingId: null,
    userCode: null,
    state: 'connected',
    reachable: true,
    authenticated: true,
    error: null,
  });
}

/**
 * Surveille `getPairingStatus` jusqu'à l'approbation. Dès que le proxy réseau
 * local approuve, échange le jeton, le vérifie puis passe à `connected` sans
 * clic. S'arrête sur `denied`, erreur, expiration ou 404. Un seul poll actif à
 * la fois : toute nouvelle tentative annule le précédent.
 */
function beginPairingPolling(url: string, pairingId: string, fetchImpl: FetchLike): void {
  cancelPairingPolling();
  const generation = pairingPollGeneration;
  const controller = new AbortController();
  pairingPollAbort = controller;
  pairingPollUrl = url;
  pairingPollTimer = setInterval(() => {
    if (pairingPollInFlight) return;
    pairingPollInFlight = true;
    void (async () => {
      try {
        const status = await getPairingStatus(url, pairingId, fetchImpl, controller.signal);
        if (generation !== pairingPollGeneration) return;
        if (status.status === 'approved') {
          // Fige la surveillance sans invalider la génération : l'échange qui
          // suit doit pouvoir aboutir.
          if (pairingPollTimer !== null) {
            clearInterval(pairingPollTimer);
            pairingPollTimer = null;
          }
          pairingPollAbort = null;
          pairingPollUrl = null;
          await completeConnection(url, pairingId, fetchImpl, generation);
          return;
        }
        if (status.status === 'denied') {
          cancelPairingPolling();
          useProxyStore.setState({
            state: 'error',
            reachable: false,
            authenticated: false,
            error: 'Accès refusé depuis la console du proxy.',
          });
        }
      } catch (error) {
        if (generation !== pairingPollGeneration) return;
        if (isAbortError(error)) return;
        cancelPairingPolling();
        useProxyStore.setState({
          state: 'error',
          reachable: false,
          authenticated: false,
          error: messageOf(error),
        });
      } finally {
        if (generation === pairingPollGeneration) pairingPollInFlight = false;
      }
    })();
  }, PAIRING_POLL_INTERVAL_MS);
}

/**
 * Store proxy réseau local.
 *
 * Garantie d'honnêteté : `connected` n'est déclaré qu'après une vraie réponse
 * `/health` (`wispVersion` compatible) **et** une vérification authentifiée du
 * jeton (`verifyToken` → `{ok:true}`). Un `/health` OK sans jeton valide donne
 * `pairing-required` (proxy joint mais pas authentifié) ; un jeton présent mais
 * refusé (`401`/`403`) est effacé puis `pairing-required`. `reachable` et
 * `authenticated` exposent ces niveaux distincts sans casser l'API existante.
 *
 * Persistance : le token de session est conservé dans `localStorage`
 * (`lumiboot.proxy.session`) afin de survivre à un rechargement de page
 * (F5). À la restauration, il est revalidé par `verifyToken` **avant** de
 * déclarer `connected`. Compromis sécurité assumé : le token est **loopback
 * uniquement**, **lié à l'origine** LumiBoot, à **TTL** (expiration vérifiée à
 * la relecture) et **révocable** ; il est **supprimé à la révocation, à
 * l'expiration ou sur refus authentifié**. `getProxyRuntimeCredentials()`
 * continue de lire le token mémoire, jamais le stockage, et ne le renvoie que
 * si l'état est réellement authentifié.
 */
export const useProxyStore = create<ProxyStoreState>((set, get) => ({
  state: 'not-running',
  reachable: false,
  authenticated: false,
  token: null,
  pairingId: null,
  userCode: null,
  error: null,

  refresh: async (fetchImpl: FetchLike = fetch) => {
    const { url } = resolveProxyConfig();
    // Changement d'URL : toute surveillance d'appairage en cours devient caduque.
    if (pairingPollUrl !== null && pairingPollUrl !== url) {
      cancelPairingPolling();
    }
    const health = await checkProxy(url, fetchImpl);
    if (health.state !== 'connected') {
      set({
        state: health.state,
        reachable: false,
        authenticated: false,
        error: health.error ?? null,
      });
      return;
    }
    // `/health` OK → joignable, mais pas encore authentifié.
    const currentToken = get().token ?? loadProxySession(url)?.token ?? null;
    if (currentToken === null) {
      set({
        token: null,
        state: 'pairing-required',
        reachable: true,
        authenticated: false,
        error: null,
      });
      return;
    }
    let verification: VerifyTokenResult;
    try {
      verification = await verifyToken(url, currentToken, fetchImpl);
    } catch (error) {
      // Erreur réseau pendant la vérification : incertain, jamais `connected`.
      set({
        token: currentToken,
        state: 'error',
        reachable: true,
        authenticated: false,
        error: messageOf(error),
      });
      return;
    }
    if (!verification.ok) {
      // Jeton refusé (401/403) : on l'oublie et on repasse en appairage.
      clearProxySession();
      set({
        token: null,
        state: 'pairing-required',
        reachable: true,
        authenticated: false,
        error: null,
      });
      return;
    }
    set({
      token: currentToken,
      state: 'connected',
      reachable: true,
      authenticated: true,
      error: null,
    });
  },

  startPairing: async (fetchImpl: FetchLike = fetch) => {
    cancelPairingPolling();
    set({ state: 'connecting', reachable: false, authenticated: false, error: null });
    const { url } = resolveProxyConfig();
    try {
      const { pairingId, userCode } = await requestPairing(url, fetchImpl);
      set({
        pairingId,
        userCode,
        state: 'pairing-required',
        reachable: true,
        authenticated: false,
        error: null,
      });
      // Auto-connexion : on surveille l'approbation côté console du proxy.
      beginPairingPolling(url, pairingId, fetchImpl);
    } catch (error) {
      cancelPairingPolling();
      set({ state: 'error', reachable: false, authenticated: false, error: messageOf(error) });
    }
  },

  connect: async (pairingId?: string, fetchImpl: FetchLike = fetch) => {
    const id = pairingId ?? get().pairingId;
    if (!id) {
      set({
        state: 'error',
        reachable: false,
        authenticated: false,
        error: 'Aucune demande d’appairage en cours : lancez l’appairage.',
      });
      return;
    }
    // Repli manuel : on prend la main sur l'auto-connexion.
    cancelPairingPolling();
    const generation = pairingPollGeneration;
    const { url } = resolveProxyConfig();
    try {
      const status = await getPairingStatus(url, id, fetchImpl);
      if (status.status === 'denied') {
        set({
          state: 'error',
          reachable: false,
          authenticated: false,
          error: 'Accès refusé depuis la console du proxy.',
        });
        return;
      }
      if (status.status === 'pending') {
        set({
          state: 'pairing-required',
          reachable: true,
          authenticated: false,
          error: 'En attente d’autorisation : validez le code depuis la console du proxy.',
        });
        // Reprend la surveillance pour finir l'appairage sans nouveau clic.
        beginPairingPolling(url, id, fetchImpl);
        return;
      }
      await completeConnection(url, id, fetchImpl, generation);
    } catch (error) {
      set({ state: 'error', reachable: false, authenticated: false, error: messageOf(error) });
    }
  },

  revoke: async (fetchImpl: FetchLike = fetch) => {
    cancelPairingPolling();
    const { token } = get();
    const { url } = resolveProxyConfig();
    if (token) {
      try {
        await revokeSession(url, token, fetchImpl);
      } catch (error) {
        set({ state: 'error', reachable: false, authenticated: false, error: messageOf(error) });
        return;
      }
    }
    clearProxySession();
    set({
      token: null,
      pairingId: null,
      userCode: null,
      authenticated: false,
      error: null,
    });
    const health = await checkProxy(url, fetchImpl);
    set({
      state: health.state === 'connected' ? 'pairing-required' : health.state,
      reachable: health.state === 'connected',
      authenticated: false,
      error: health.error ?? null,
    });
  },

  dismissError: () => {
    cancelPairingPolling();
    set({ error: null });
  },

  cancelPairing: () => {
    cancelPairingPolling();
  },
}));

/**
 * Jeton runtime pour le profil réseau de la session (lu en mémoire). Le jeton
 * n'est renvoyé que si l'état est **réellement authentifié** (`connected` +
 * jeton) : un `/health` OK seul ne suffit jamais à auto-sélectionner
 * `local-proxy`.
 */
export function getProxyRuntimeCredentials(): {
  proxyUrl: string;
  proxyToken: string | null;
} {
  const { url } = resolveProxyConfig();
  const { state, token } = useProxyStore.getState();
  const authenticated = state === 'connected' && token !== null;
  return { proxyUrl: url, proxyToken: authenticated ? token : null };
}
