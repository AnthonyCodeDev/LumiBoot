import { PROXY_WISP_VERSION, type ProxyState } from '@lumiboot/vm-network';
import type { FetchLike } from '../../config/load-config';

/** Résultat de la sonde `/health` du proxy réseau local. */
export interface ProxyHealth {
  state: ProxyState;
  version?: string;
  wispVersion?: number;
  /** Message de diagnostic guidé (état `error` incertain). */
  error?: string;
  /**
   * `true` quand la sonde ne permet pas de trancher (ex. `TypeError` Chromium
   * ambigu entre proxy arrêté et refus d'accès réseau local).
   */
  uncertain?: boolean;
}

/** Délai de sonde : le proxy réseau local est local, 1500 ms suffisent. */
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
 * Le navigateur supporte-t-il Local Network Access (heuristique) ?
 *
 * Chrome/Chromium récent expose `navigator.userAgentData` ; à défaut on
 * détecte un UA Chromium. Hors Chromium, la notion n'existe pas → `false`.
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
 * Sonde le proxy réseau local via `GET {baseUrl}/health`.
 *
 * Routes réellement utilisées (cf. `apps/network-proxy/internal/server/server.go`) :
 * - `GET /health` → `{status: "ok", version, wispVersion: 1, …}`.
 *
 * Interprétation :
 * - erreur réseau / timeout (y compris `AbortError`) → `not-running` ;
 * - réponse non-JSON ou forme inattendue → `incompatible` ;
 * - `wispVersion !== PROXY_WISP_VERSION` → `incompatible` ;
 * - succès → `connected` (proxy réseau local **joint**, pas encore appairé : le store
 *   exige en plus un token avant d'afficher « Connecté »).
 *
 * État **incertain** (LIMITATION DOCUMENTÉE) : quand le fetch échoue par
 * `TypeError` alors que `window.isSecureContext` est vrai ET que
 * l'environnement supporte Local Network Access (Chromium), le navigateur ne
 * permet PAS de distinguer un refus LNA d'un proxy réseau local arrêté : les
 * deux produisent le même `TypeError` générique (« Failed to fetch »). On
 * renvoie donc un état `error` **incertain** (`uncertain: true`) portant un
 * message de diagnostic guidé, au lieu d'affirmer `permission-required`. Hors
 * contexte sécurisé ou hors Chromium, le même échec donne `not-running`.
 *
 * `not-installed` n'est JAMAIS renvoyé ici : l'absence de réponse ne prouve
 * pas l'absence d'installation.
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
          // Chromium : impossible de trancher entre refus LNA et proxy arrêté.
          return {
            state: 'error',
            uncertain: true,
            error:
              'Impossible de joindre le proxy réseau local : le navigateur a pu bloquer ' +
              'l’accès au réseau local, ou le proxy n’est pas lancé. Vérifiez qu’il tourne ' +
              'sur cette machine, puis autorisez l’accès au réseau local pour ce site.',
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
