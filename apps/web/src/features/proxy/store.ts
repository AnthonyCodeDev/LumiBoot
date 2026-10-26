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

/** Pairing approval watch interval (auto-connect). */
export const PAIRING_POLL_INTERVAL_MS = 1500;

export interface ProxyStoreState {
  /**
   * Real state: `connected` requires a healthy `/health` **and** a successful
   * authenticated token check (`verifyToken`).
   */
  state: ProxyState;
  /** `/health` answered (local network proxy reachable). Necessary, not enough. */
  reachable: boolean;
  /** The token was really validated by the proxy (authenticated check). */
  authenticated: boolean;
  /** Session token in memory (runtime source of truth). */
  token: string | null;
  pairingId: string | null;
  userCode: string | null;
  error: string | null;
  refresh: (fetchImpl?: FetchLike) => Promise<void>;
  startPairing: (fetchImpl?: FetchLike) => Promise<void>;
  connect: (pairingId?: string, fetchImpl?: FetchLike) => Promise<void>;
  revoke: (fetchImpl?: FetchLike) => Promise<void>;
  dismissError: () => void;
  /** Cancels any in-flight pairing watch (e.g. component unmount). */
  cancelPairing: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof ProxyPairingError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected local network proxy error.';
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'AbortError'
  );
}

/** Active pairing watch interval (at most one at a time). */
let pairingPollTimer: ReturnType<typeof setInterval> | null = null;
/** Prevents two status polls from overlapping. */
let pairingPollInFlight = false;
/**
 * Watch generation: incremented on every cancel/restart. Any response from an
 * outdated generation is ignored (fewer races).
 */
let pairingPollGeneration = 0;
/** `AbortController` of the current poll: aborts the in-flight network request. */
let pairingPollAbort: AbortController | null = null;
/** URL the current poll is for (detects URL changes). */
let pairingPollUrl: string | null = null;

/**
 * Stops the pairing watch when active. Idempotent.
 * Invalidates the current generation: responses already in flight are ignored.
 */
function cancelPairingPolling(): void {
  pairingPollGeneration += 1;
  pairingPollInFlight = false;
  pairingPollUrl = null;
  if (pairingPollAbort !== null) {
    try {
      pairingPollAbort.abort();
    } catch {
      // `abort()` must never make the cancellation fail.
    }
    pairingPollAbort = null;
  }
  if (pairingPollTimer !== null) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
}

/**
 * Exchanges an approved pairing for a token, then **checks** that token
 * authentically before asserting `connected`. `generation` stops a late
 * connection from overwriting a more recent state (revocation, new try…).
 */
async function completeConnection(
  url: string,
  pairingId: string,
  fetchImpl: FetchLike,
  generation: number,
): Promise<void> {
  const { token, expiresAt } = await exchangeToken(url, pairingId, fetchImpl);
  if (generation !== pairingPollGeneration) return;
  // `/health` first: the proxy must be reachable…
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
  // …then the token must be really validated (authenticated check).
  const verification = await verifyToken(url, token, fetchImpl);
  if (generation !== pairingPollGeneration) return;
  if (!verification.ok) {
    // Token refused: persist nothing and go back to pairing.
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
  // The token is only persisted after authenticated validation.
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
 * Watches `getPairingStatus` until approval. Once the local network proxy
 * approves, exchanges the token, verifies it, then switches to `connected` with
 * no click. Stops on `denied`, error, expiry or 404. Only one active poll at a
 * time: any new attempt cancels the previous one.
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
          // Freezes the watch without invalidating the generation: the exchange
          // that follows must be able to complete.
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
            error: 'Access refused from the proxy console.',
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
 * Local network proxy store.
 *
 * Honesty guarantee: `connected` is only declared after a real `/health`
 * response (compatible `wispVersion`) **and** an authenticated token check
 * (`verifyToken` → `{ok:true}`). A healthy `/health` without a valid token yields
 * `pairing-required` (proxy reached but not authenticated); a token that is
 * present but refused (`401`/`403`) is cleared, then `pairing-required`.
 * `reachable` and `authenticated` expose these distinct levels without breaking
 * the existing API.
 *
 * Persistence: the session token is kept in `sessionStorage`
 * (`lumiboot.proxy.session`) so it survives a page reload (F5) **in the same
 * tab**, without persisting past its closure. On restore, it is revalidated by
 * `verifyToken` **before** declaring `connected`. Accepted security trade-off:
 * the token is **loopback only**, **bound to the LumiBoot origin**, **TTL-bound**
 * (expiry checked on re-read) and **revocable**; it is **deleted on revocation
 * (disconnect), on expiry or on an authenticated refusal**. The legacy
 * `localStorage` key from an earlier version is purged with no migration.
 * `getProxyRuntimeCredentials()` keeps reading the in-memory token, never the
 * storage, and only returns it when the state is really authenticated.
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
    // URL change: any in-flight pairing watch becomes stale.
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
    // `/health` OK → reachable, but not authenticated yet.
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
      // Network error during the check: uncertain, never `connected`.
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
      // Token refused (401/403): forget it and go back to pairing.
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
      // Auto-connect: watch for approval from the proxy console.
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
        error: 'No pairing request in progress: start the pairing.',
      });
      return;
    }
    // Manual fallback: take over from the auto-connect.
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
          error: 'Access refused from the proxy console.',
        });
        return;
      }
      if (status.status === 'pending') {
        set({
          state: 'pairing-required',
          reachable: true,
          authenticated: false,
          error: 'Waiting for authorization: validate the code from the proxy console.',
        });
        // Resumes the watch to finish pairing without another click.
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
 * Runtime token for the session network profile (read from memory). The token is
 * only returned when the state is **really authenticated** (`connected` + token):
 * a healthy `/health` alone is never enough to auto-select `local-proxy`.
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
