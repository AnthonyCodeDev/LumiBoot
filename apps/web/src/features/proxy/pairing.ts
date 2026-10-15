import type { FetchLike } from '../../config/load-config';

/**
 * Appairage web ↔ proxy réseau local.
 *
 * Routes réellement utilisées (cf.
 * `apps/network-proxy/internal/server/server.go` + `README.md`) :
 * - `POST /api/pair/request` (origine autorisée) → `{pairingId, userCode, expiresAt}` ;
 * - `GET /api/pair/status?id=…` → `{status: "pending"|"approved"|"denied", expiresAt}` ;
 * - `POST /api/pair/exchange` `{pairingId}` (même origine) → `{token, expiresAt}` ;
 * - `POST /api/session/revoke` `{token}` → `{revoked: true}`.
 *
 * L'approbation elle-même (`approve`/`deny`) se fait depuis la console du
 * proxy réseau local (terminal), jamais depuis LumiBoot web.
 */

export type PairingStatusValue = 'pending' | 'approved' | 'denied';

export interface PairingRequestResult {
  pairingId: string;
  userCode: string;
  expiresAt: string;
}

export interface PairingStatusResult {
  status: PairingStatusValue;
  expiresAt: string;
}

export interface PairingExchangeResult {
  token: string;
  expiresAt: string;
}

export class ProxyPairingError extends Error {
  readonly code:
    | 'ORIGIN_FORBIDDEN'
    | 'PAIRING_NOT_FOUND'
    | 'PAIRING_NOT_APPROVED'
    | 'REVOKE_FAILED'
    | 'PROXY_UNREACHABLE';

  constructor(code: ProxyPairingError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyPairingError';
    this.code = code;
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function currentOrigin(): string | undefined {
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    return window.location.origin;
  }
  return undefined;
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const message = (body as { error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  } catch {
    // Corps non-JSON : on retombe sur le statut HTTP.
  }
  return undefined;
}

async function postJson<T>(
  url: string,
  payload: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<{ ok: true; data: T } | { ok: false; status: number; detail?: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Proxy réseau local injoignable : vérifiez qu’il est lancé sur cette machine.',
      { cause },
    );
  }
  if (!response.ok) {
    const detail = await readErrorMessage(response);
    return detail === undefined
      ? { ok: false, status: response.status }
      : { ok: false, status: response.status, detail };
  }
  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Réponse inattendue du proxy réseau local (JSON illisible).',
      { cause },
    );
  }
}

/**
 * Demande un appairage : le navigateur envoie son origine (en-tête `Origin`
 * automatique + `origin` explicite en repli, car le serveur accepte les deux).
 */
export async function requestPairing(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<PairingRequestResult> {
  const origin = currentOrigin();
  const result = await postJson<PairingRequestResult>(
    `${trimBaseUrl(baseUrl)}/api/pair/request`,
    origin === undefined ? {} : { origin },
    fetchImpl,
  );
  if (!result.ok) {
    if (result.status === 403) {
      throw new ProxyPairingError(
        'ORIGIN_FORBIDDEN',
        `Origine refusée par le proxy réseau local${result.detail ? ` : ${result.detail}` : ''}. Ajoutez cette origine à la configuration du proxy réseau local puis relancez-le.`,
      );
    }
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Demande d’appairage refusée (HTTP ${result.status})${result.detail ? ` : ${result.detail}` : ''}.`,
    );
  }
  const { pairingId, userCode, expiresAt } = result.data;
  if (typeof pairingId !== 'string' || typeof userCode !== 'string') {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Réponse d’appairage inattendue du proxy réseau local.',
    );
  }
  return { pairingId, userCode, expiresAt };
}

/** Consulte l'état d'une demande d'appairage. */
export async function getPairingStatus(
  baseUrl: string,
  pairingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<PairingStatusResult> {
  const url = `${trimBaseUrl(baseUrl)}/api/pair/status?id=${encodeURIComponent(pairingId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Proxy réseau local injoignable pendant la vérification de l’appairage.',
      { cause },
    );
  }
  if (response.status === 404) {
    throw new ProxyPairingError(
      'PAIRING_NOT_FOUND',
      'Demande d’appairage introuvable ou expirée : recommencez l’appairage.',
    );
  }
  if (response.status === 403) {
    const detail = await readErrorMessage(response);
    throw new ProxyPairingError(
      'ORIGIN_FORBIDDEN',
      `Origine refusée par le proxy réseau local${detail ? ` : ${detail}` : ''}.`,
    );
  }
  if (!response.ok) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Statut d’appairage illisible (HTTP ${response.status}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ProxyPairingError('PROXY_UNREACHABLE', 'Réponse de statut illisible.', {
      cause,
    });
  }
  const record = body as { status?: unknown; expiresAt?: unknown };
  if (record.status !== 'pending' && record.status !== 'approved' && record.status !== 'denied') {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Statut d’appairage inattendu renvoyé par le proxy réseau local.',
    );
  }
  return { status: record.status, expiresAt: String(record.expiresAt ?? '') };
}

/**
 * Échange un appairage **approuvé** contre un token de session (usage
 * unique). Le token brut n'est renvoyé qu'ici et n'est stocké que haché côté
 * proxy réseau local.
 */
export async function exchangeToken(
  baseUrl: string,
  pairingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<PairingExchangeResult> {
  const result = await postJson<PairingExchangeResult>(
    `${trimBaseUrl(baseUrl)}/api/pair/exchange`,
    { pairingId },
    fetchImpl,
  );
  if (!result.ok) {
    if (result.status === 403) {
      throw new ProxyPairingError(
        'PAIRING_NOT_APPROVED',
        'Échange impossible : approuvez d’abord la demande depuis la console du proxy (même origine requise).',
      );
    }
    if (result.status === 404) {
      throw new ProxyPairingError(
        'PAIRING_NOT_FOUND',
        'Demande d’appairage introuvable ou expirée : recommencez l’appairage.',
      );
    }
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Échange du token refusé (HTTP ${result.status})${result.detail ? ` : ${result.detail}` : ''}.`,
    );
  }
  const { token, expiresAt } = result.data;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Token de session manquant dans la réponse du proxy réseau local.',
    );
  }
  return { token, expiresAt };
}

/** Révoque la session par possession du token brut. */
export async function revokeSession(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const result = await postJson<{ revoked?: unknown }>(
    `${trimBaseUrl(baseUrl)}/api/session/revoke`,
    { token },
    fetchImpl,
  );
  if (!result.ok) {
    throw new ProxyPairingError(
      'REVOKE_FAILED',
      `Révocation impossible (HTTP ${result.status}) : session déjà expirée ou introuvable.`,
    );
  }
  if (result.data.revoked !== true) {
    throw new ProxyPairingError(
      'REVOKE_FAILED',
      'Révocation refusée par le proxy réseau local.',
    );
  }
}
