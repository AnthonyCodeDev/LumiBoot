import type { FetchLike } from '../../config/load-config';

/** Web ↔ proxy pairing endpoints; approval happens in the proxy console only. */

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
  ok: boolean;
  expiresAt?: string;
}

export class ProxyPairingError extends Error {
  readonly code:
    | 'ORIGIN_FORBIDDEN'
    | 'PAIRING_NOT_FOUND'
    | 'PAIRING_NOT_APPROVED'
    | 'REVOKE_FAILED'
    | 'PROXY_UNREACHABLE'
    | 'PROXY_TIMEOUT';

  constructor(code: ProxyPairingError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProxyPairingError';
    this.code = code;
  }
}

/** Hard deadline of a pairing round trip: a silent proxy must not freeze the UI. */
export const PAIRING_REQUEST_TIMEOUT_MS = 10_000;

const PAIRING_TIMEOUT_MESSAGE = 'The local network proxy did not answer in time.';

function proxyTimeoutError(cause?: unknown): ProxyPairingError {
  return cause === undefined
    ? new ProxyPairingError('PROXY_TIMEOUT', PAIRING_TIMEOUT_MESSAGE)
    : new ProxyPairingError('PROXY_TIMEOUT', PAIRING_TIMEOUT_MESSAGE, { cause });
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Composes the caller signal with the request deadline (`AbortSignal.any` when available). */
function createDeadlineSignal(
  external: AbortSignal | undefined,
  controller: AbortController,
): { signal: AbortSignal; dispose: () => void } {
  if (external === undefined) return { signal: controller.signal, dispose: () => {} };
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([external, controller.signal]), dispose: () => {} };
  }
  if (external.aborted) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }
  const forward = (): void => controller.abort();
  external.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    dispose: () => external.removeEventListener('abort', forward),
  };
}

/** Runs a proxy request with a hard deadline; races the request because an injected `fetchImpl` may ignore the abort. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = PAIRING_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const deadline = createDeadlineSignal(init.signal ?? undefined, controller);
  let timedOut = false;
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(timedOut ? proxyTimeoutError() : new DOMException('Aborted', 'AbortError'));
    };
    if (deadline.signal.aborted) {
      fail();
      return;
    }
    deadline.signal.addEventListener('abort', fail, { once: true });
    removeAbortListener = () => deadline.signal.removeEventListener('abort', fail);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([fetchImpl(url, { ...init, signal: deadline.signal }), aborted]);
  } catch (error) {
    // Whichever rejection wins the race, a missed deadline is reported as such.
    if (timedOut) throw proxyTimeoutError(error);
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
    deadline.dispose();
  }
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

async function postJson(
  url: string,
  payload: Record<string, unknown>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; detail?: string }> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    // A missed deadline is a distinct, actionable failure: keep its code.
    if (cause instanceof ProxyPairingError) throw cause;
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
    const data: unknown = await response.json();
    return { ok: true, data };
  } catch (cause) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Unexpected response from the local network proxy (unreadable JSON).',
      { cause },
    );
  }
}

/** The origin is only carried by the browser `Origin` header, which the proxy checks. */
export async function requestPairing(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<PairingRequestResult> {
  const result = await postJson(`${trimBaseUrl(baseUrl)}/api/pair/request`, {}, fetchImpl);
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
  if (!isRecord(result.data)) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Unexpected pairing response from the local network proxy.',
    );
  }
  const { pairingId, userCode, expiresAt } = result.data;
  if (
    typeof pairingId !== 'string' ||
    pairingId.length === 0 ||
    typeof userCode !== 'string' ||
    userCode.length === 0 ||
    typeof expiresAt !== 'string'
  ) {
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
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause instanceof ProxyPairingError) throw cause;
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
  const record = isRecord(body) ? body : {};
  if (
    (record.status !== 'pending' && record.status !== 'approved' && record.status !== 'denied') ||
    typeof record.expiresAt !== 'string'
  ) {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Unexpected pairing status returned by the local network proxy.',
    );
  }
  return { status: record.status, expiresAt: record.expiresAt };
}

/** Exchanges an approved pairing for a session token. The token is single use. */
export async function exchangeToken(
  baseUrl: string,
  pairingId: string,
  fetchImpl: FetchLike = fetch,
): Promise<PairingExchangeResult> {
  const result = await postJson(
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
  const record = isRecord(result.data) ? result.data : {};
  const { token, expiresAt } = record;
  if (typeof token !== 'string' || token.length === 0 || typeof expiresAt !== 'string') {
    throw new ProxyPairingError(
      'PROXY_UNREACHABLE',
      'Session token missing in the local network proxy response.',
    );
  }
  return { token, expiresAt };
}

/** Token travels in the query, like `/wisp/`, to avoid a preflight; a network error is uncertain. */
export async function verifyToken(
  baseUrl: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<VerifyTokenResult> {
  const url = `${trimBaseUrl(baseUrl)}/api/session/verify?token=${encodeURIComponent(token)}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (cause instanceof ProxyPairingError) throw cause;
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
  if (!isRecord(body)) {
    throw new ProxyPairingError('PROXY_UNREACHABLE', 'Unexpected token verification response.');
  }
  const record = body;
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
  const result = await postJson(`${trimBaseUrl(baseUrl)}/api/session/revoke`, { token }, fetchImpl);
  if (!result.ok) {
    throw new ProxyPairingError(
      'REVOKE_FAILED',
      `Cannot revoke (HTTP ${result.status}): session already expired or not found.`,
    );
  }
  if (!isRecord(result.data) || result.data.revoked !== true) {
    throw new ProxyPairingError('REVOKE_FAILED', 'Revocation refused by the local network proxy.');
  }
}
