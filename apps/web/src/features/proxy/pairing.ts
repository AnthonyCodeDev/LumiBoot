import type { FetchLike } from '../../config/load-config';

/**
 * Web to local network proxy pairing over `POST /api/pair/request`,
 * `GET /api/pair/status`, `POST /api/pair/exchange`, `GET /api/session/verify`
 * and `POST /api/session/revoke`. Approval happens in the proxy console only.
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

export interface VerifyTokenResult {
  /** The proxy confirmed the token is valid. */
  ok: boolean;
  /** Expiry returned by the proxy, when known. */
  expiresAt?: string;
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
    // Non-JSON body: fall back to the HTTP status.
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
      'Local network proxy unreachable: check that it runs on this machine.',
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
      'Unexpected response from the local network proxy (unreadable JSON).',
      { cause },
    );
  }
}

/**
 * Requests a pairing. Both the automatic `Origin` header and an explicit
 * `origin` field are sent because the server accepts either.
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
        `Origin refused by the local network proxy${result.detail ? `: ${result.detail}` : ''}. Add this origin to the local network proxy config, then restart it.`,
      );
    }
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Pairing request refused (HTTP ${result.status})${result.detail ? `: ${result.detail}` : ''}.`,
    );
  }
  const { pairingId, userCode, expiresAt } = result.data;
  if (typeof pairingId !== 'string' || typeof userCode !== 'string') {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Unexpected pairing response from the local network proxy.',
    );
  }
  return { pairingId, userCode, expiresAt };
}

/** Reads the state of a pairing request. */
export async function getPairingStatus(
  baseUrl: string,
  pairingId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<PairingStatusResult> {
  const url = `${trimBaseUrl(baseUrl)}/api/pair/status?id=${encodeURIComponent(pairingId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Local network proxy unreachable while checking the pairing.',
      { cause },
    );
  }
  if (response.status === 404) {
    throw new ProxyPairingError(
      'PAIRING_NOT_FOUND',
      'Pairing request not found or expired: start the pairing again.',
    );
  }
  if (response.status === 403) {
    const detail = await readErrorMessage(response);
    throw new ProxyPairingError(
      'ORIGIN_FORBIDDEN',
      `Origin refused by the local network proxy${detail ? `: ${detail}` : ''}.`,
    );
  }
  if (!response.ok) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Unreadable pairing status (HTTP ${response.status}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ProxyPairingError('PROXY_UNREACHABLE', 'Unreadable status response.', {
      cause,
    });
  }
  const record = body as { status?: unknown; expiresAt?: unknown };
  if (record.status !== 'pending' && record.status !== 'approved' && record.status !== 'denied') {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Unexpected pairing status returned by the local network proxy.',
    );
  }
  return { status: record.status, expiresAt: String(record.expiresAt ?? '') };
}

/** Exchanges an approved pairing for a session token. The token is single use. */
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
        'Cannot exchange: approve the request from the proxy console first (same origin required).',
      );
    }
    if (result.status === 404) {
      throw new ProxyPairingError(
        'PAIRING_NOT_FOUND',
        'Pairing request not found or expired: start the pairing again.',
      );
    }
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Token exchange refused (HTTP ${result.status})${result.detail ? `: ${result.detail}` : ''}.`,
    );
  }
  const { token, expiresAt } = result.data;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Session token missing in the local network proxy response.',
    );
  }
  return { token, expiresAt };
}

/**
 * Checks a session token with the proxy. The token travels in the query, like
 * `/wisp/`, to avoid a preflight. A network error is uncertain, not invalid.
 */
export async function verifyToken(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<VerifyTokenResult> {
  const url = `${trimBaseUrl(baseUrl)}/api/session/verify?token=${encodeURIComponent(token)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Local network proxy unreachable while verifying the session token.',
      { cause },
    );
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false };
  }
  if (!response.ok) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      `Unreadable token verification (HTTP ${response.status}).`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new ProxyPairingError('PROXY_UNREACHABLE', 'Unreadable token verification response.', {
      cause,
    });
  }
  const record = body as { ok?: unknown; expiresAt?: unknown };
  if (record.ok !== true) return { ok: false };
  return typeof record.expiresAt === 'string'
    ? { ok: true, expiresAt: record.expiresAt }
    : { ok: true };
}

/** Revokes the session by possession of the raw token. */
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
      `Cannot revoke (HTTP ${result.status}): session already expired or not found.`,
    );
  }
  if (result.data.revoked !== true) {
    throw new ProxyPairingError('REVOKE_FAILED', 'Revocation refused by the local network proxy.');
  }
}
