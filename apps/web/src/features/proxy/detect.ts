import { PROXY_WISP_VERSION, type ProxyState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';

/** Result of the local network proxy `/health` probe. */
export interface ProxyHealth {
  state: ProxyState;
  version?: string;
  wispVersion?: number;
  /** Guided diagnostic message (uncertain `error` state). */
  error?: string;
  /**
   * `true` when the probe cannot decide (e.g. Chromium `TypeError` that is
   * ambiguous between a stopped proxy and a local network access refusal).
   */
  uncertain?: boolean;
}

/** Probe timeout: the local network proxy is local, 1500 ms is enough. */
export const PROXY_HEALTH_TIMEOUT_MS = 1500;

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException
      ? error.name === 'AbortError' || error.name === 'TimeoutError'
      : false) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'AbortError')
  );
}

/**
 * Does the browser support Local Network Access (heuristic)?
 *
 * Recent Chrome/Chromium exposes `navigator.userAgentData`; failing that, a
 * Chromium UA is detected. Outside Chromium the concept does not exist → `false`.
 */
export function supportsLocalNetworkAccess(nav?: {
  userAgent?: string;
  userAgentData?: unknown;
}): boolean {
  const candidate =
    nav ??
    (typeof navigator !== 'undefined'
      ? (navigator as unknown as { userAgent?: string; userAgentData?: unknown })
      : undefined);
  if (!candidate) return false;
  if (candidate.userAgentData !== undefined) return true;
  return /chrome|chromium|edg/i.test(candidate.userAgent ?? '');
}

function isSecureContextActive(): boolean {
  if (typeof window !== 'undefined' && typeof window.isSecureContext === 'boolean') {
    return window.isSecureContext;
  }
  return false;
}

/**
 * Probes the local network proxy through `GET {baseUrl}/health`.
 *
 * Routes actually used (see `apps/network-proxy/internal/server/server.go`):
 * - `GET /health` → `{status: "ok", version, wispVersion: 1, …}`.
 *
 * Interpretation:
 * - network error / timeout (including `AbortError`) → `not-running`;
 * - non-JSON response or unexpected shape → `incompatible`;
 * - `wispVersion !== PROXY_WISP_VERSION` → `incompatible`;
 * - success → `connected` (local network proxy **reached**, not paired yet: the
 *   store also requires a token before showing "Connected").
 *
 * **Uncertain** state (DOCUMENTED LIMITATION): when the fetch fails with a
 * `TypeError` while `window.isSecureContext` is true AND the environment supports
 * Local Network Access (Chromium), the browser does NOT let us tell an LNA
 * refusal apart from a stopped local network proxy: both produce the same
 * generic `TypeError` ("Failed to fetch"). We therefore return an **uncertain**
 * `error` state (`uncertain: true`) carrying a guided diagnostic message,
 * instead of asserting `permission-required`. Outside a secure context or
 * outside Chromium, the same failure yields `not-running`.
 *
 * `not-installed` is NEVER returned here: the absence of a response does not
 * prove the absence of an installation.
 */
export async function checkProxy(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProxyHealth> {
  const url = `${trimBaseUrl(baseUrl)}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_HEALTH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (isAbortError(error)) return { state: 'not-running' };
      if (error instanceof TypeError) {
        if (isSecureContextActive() && supportsLocalNetworkAccess()) {
          // Chromium: cannot decide between an LNA refusal and a stopped proxy.
          return {
            state: 'error',
            uncertain: true,
            error:
              'Unable to reach the local network proxy: the browser may have blocked ' +
              'local network access, or the proxy is not running. Check that it runs on ' +
              'this machine, then allow local network access for this site.',
          };
        }
        return { state: 'not-running' };
      }
      return { state: 'not-running' };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return { state: 'incompatible' };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { state: 'incompatible' };
    }
    if (typeof body !== 'object' || body === null) return { state: 'incompatible' };
    const record = body as Record<string, unknown>;
    if (record['status'] !== 'ok') return { state: 'incompatible' };
    const wispVersion = record['wispVersion'];
    if (typeof wispVersion !== 'number') return { state: 'incompatible' };
    if (wispVersion !== PROXY_WISP_VERSION) {
      return {
        state: 'incompatible',
        wispVersion,
        ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}),
      };
    }
    return {
      state: 'connected',
      wispVersion,
      ...(typeof record['version'] === 'string' ? { version: record['version'] } : {}),
    };
  } catch {
    return { state: 'not-running' };
  }
}
