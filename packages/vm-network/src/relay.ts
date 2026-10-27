export interface RelayValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** `ws:` is only tolerated on localhost when `allowInsecure` is set. */
export function validateRelayUrl(
  raw: unknown,
  options: { allowInsecure?: boolean } = {},
): RelayValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Invalid relay address: a string is expected.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty relay address.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Malformed relay address.' };
  }

  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    return { ok: false, error: 'Only the "wss:" protocol is allowed.' };
  }

  if (url.protocol === 'ws:') {
    const allowInsecure = options.allowInsecure === true;
    if (!allowInsecure || !isLocalHostname(url.hostname)) {
      return {
        ok: false,
        error: 'The "ws:" protocol (unencrypted) is reserved for localhost development.',
      };
    }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'Credentials (userinfo) are not allowed in the URL.' };
  }

  if (url.hash !== '') {
    return { ok: false, error: 'The fragment ("#…") is not allowed.' };
  }

  if (url.hostname === '') {
    return { ok: false, error: 'The hostname is required.' };
  }

  return { ok: true, url: url.href };
}
