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

export const PAIRING_POLL_INTERVAL_MS = 1500;

export interface ProxyStoreState {
  /** `connected` requires a healthy `/health` and a successful `verifyToken`. */
  state: ProxyState;
  /** `/health` answered. Necessary, not sufficient. */
  reachable: boolean;
  authenticated: boolean;
  token: string | null;
  pairingId: string | null;
  userCode: string | null;
  error: string | null;
  refresh: (fetchImpl?: FetchLike) => Promise<void>;
  startPairing: (fetchImpl?: FetchLike) => Promise<void>;
  connect: (pairingId?: string, fetchImpl?: FetchLike) => Promise<void>;
  revoke: (fetchImpl?: FetchLike) => Promise<void>;
  dismissError: () => void;
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

/** Active pairing watch (at most one); generation counters discard stale responses. */
let pairingPollTimer: ReturnType<typeof setInterval> | null = null;
let pairingPollInFlight = false;
let pairingPollGeneration = 0;
let operationGeneration = 0;
let pairingPollAbort: AbortController | null = null;
let pairingPollUrl: string | null = null;
/** Token whose server-side revocation failed: memory only, retried on next `revoke`. */
let pendingRevocation: { url: string; token: string } | null = null;

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

/** Exchanges an approved pairing for a token and verifies it before `connected`. */
async function completeConnection(
  url: string,
  pairingId: string,
  fetchImpl: FetchLike,
  generation: number,
  operation: number,
): Promise<void> {
  const { token, expiresAt } = await exchangeToken(url, pairingId, fetchImpl);
  if (generation !== pairingPollGeneration || operation !== operationGeneration) return;
  // `/health` must answer before the token is trusted.
  const health = await checkProxy(url, fetchImpl);
  if (generation !== pairingPollGeneration || operation !== operationGeneration) return;
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
  const verification = await verifyToken(url, token, fetchImpl);
  if (generation !== pairingPollGeneration || operation !== operationGeneration) return;
  if (!verification.ok) {
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
  pendingRevocation = null;
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

/** Polls `getPairingStatus` until approval, then connects; a new attempt cancels the previous one. */
function beginPairingPolling(
  url: string,
  pairingId: string,
  fetchImpl: FetchLike,
  operation: number,
): void {
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
        if (generation !== pairingPollGeneration || operation !== operationGeneration) return;
        if (status.status === 'approved') {
          // Freezes the watch without invalidating the generation.
          if (pairingPollTimer !== null) {
            clearInterval(pairingPollTimer);
            pairingPollTimer = null;
          }
          pairingPollAbort = null;
          await completeConnection(url, pairingId, fetchImpl, generation, operation);
          if (generation === pairingPollGeneration) pairingPollUrl = null;
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
        if (generation !== pairingPollGeneration || operation !== operationGeneration) return;
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

/** `connected` requires `/health` and `verifyToken`; the token is revalidated before restore. */
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
    // A refresh must not interrupt pairing against the current proxy.
    if (pairingPollUrl === url) return;
    if (pairingPollUrl !== null) cancelPairingPolling();
    const operation = ++operationGeneration;
    set({ pairingId: null, userCode: null });
    const health = await checkProxy(url, fetchImpl);
    if (operation !== operationGeneration) return;
    if (health.state !== 'connected') {
      set({
        state: health.state,
        reachable: false,
        authenticated: false,
        error: health.error ?? null,
      });
      return;
    }
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
      if (operation !== operationGeneration) return;
      // Network error: uncertain, never `connected`.
      set({
        token: currentToken,
        state: 'error',
        reachable: true,
        authenticated: false,
        error: messageOf(error),
      });
      return;
    }
    if (operation !== operationGeneration) return;
    if (!verification.ok) {
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
    // Persist the renewed deadline so a reload keeps the still-valid token.
    if (verification.expiresAt !== undefined) {
      saveProxySession({ token: currentToken, expiresAt: verification.expiresAt, proxyUrl: url });
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
    // A fresh pairing supersedes any revocation that could not be retried.
    pendingRevocation = null;
    const operation = ++operationGeneration;
    set({
      pairingId: null,
      userCode: null,
      state: 'connecting',
      reachable: false,
      authenticated: false,
      error: null,
    });
    const { url } = resolveProxyConfig();
    try {
      const { pairingId, userCode } = await requestPairing(url, fetchImpl);
      if (operation !== operationGeneration) return;
      set({
        pairingId,
        userCode,
        state: 'pairing-required',
        reachable: true,
        authenticated: false,
        error: null,
      });
      beginPairingPolling(url, pairingId, fetchImpl, operation);
    } catch (error) {
      if (operation !== operationGeneration) return;
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
    cancelPairingPolling();
    const operation = ++operationGeneration;
    const generation = pairingPollGeneration;
    const { url } = resolveProxyConfig();
    try {
      const status = await getPairingStatus(url, id, fetchImpl);
      if (operation !== operationGeneration) return;
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
        beginPairingPolling(url, id, fetchImpl, operation);
        return;
      }
      await completeConnection(url, id, fetchImpl, generation, operation);
    } catch (error) {
      if (operation !== operationGeneration) return;
      set({ state: 'error', reachable: false, authenticated: false, error: messageOf(error) });
    }
  },

  revoke: async (fetchImpl: FetchLike = fetch) => {
    cancelPairingPolling();
    const operation = ++operationGeneration;
    const { url } = resolveProxyConfig();
    // Retry a failed revocation: that token is no longer stored but still valid remotely.
    const token = get().token ?? (pendingRevocation?.url === url ? pendingRevocation.token : null);
    // Disconnect locally first so a concurrent refresh cannot restore the token.
    clearProxySession();
    set({
      token: null,
      pairingId: null,
      userCode: null,
      state: 'pairing-required',
      authenticated: false,
      error: null,
    });
    if (token) {
      try {
        await revokeSession(url, token, fetchImpl);
        pendingRevocation = null;
      } catch (error) {
        // Remember it in memory only, so a retry can still revoke it.
        pendingRevocation = { url, token };
        if (operation !== operationGeneration) return;
        set({ state: 'error', reachable: false, authenticated: false, error: messageOf(error) });
        return;
      }
    }
    if (operation !== operationGeneration) return;
    const health = await checkProxy(url, fetchImpl);
    if (operation !== operationGeneration) return;
    set({
      state: health.state === 'connected' ? 'pairing-required' : health.state,
      reachable: health.state === 'connected',
      authenticated: false,
      error: health.error ?? null,
    });
  },

  dismissError: () => {
    cancelPairingPolling();
    operationGeneration += 1;
    set({ error: null });
  },

  cancelPairing: () => {
    cancelPairingPolling();
    operationGeneration += 1;
  },
}));

/** Runtime token for the local-proxy profile; null unless `connected` with a token. */
export function getProxyRuntimeCredentials(): {
  proxyUrl: string;
  proxyToken: string | null;
} {
  const { url } = resolveProxyConfig();
  const { state, token, authenticated } = useProxyStore.getState();
  const connected = state === 'connected' && authenticated && token !== null;
  return { proxyUrl: url, proxyToken: connected ? token : null };
}
