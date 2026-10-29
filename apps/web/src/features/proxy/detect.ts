import { PROXY_WISP_VERSION, type ProxyState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';

/** Result of the local network proxy `/health` probe. */
export interface ProxyHealth {
  state: ProxyState;
  version?: string;
  wispVersion?: number;
  /** Guided diagnostic message for an uncertain `error` state. */
  error?: string;
  /** `true` when the probe cannot decide between a stopped proxy and an LNA refusal. */
  uncertain?: boolean;
}

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

/** Heuristic: `userAgentData` or a Chromium user agent means LNA is supported. */
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

/** Reached ≠ paired; a secure-context `TypeError` may be an LNA refusal. */
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
