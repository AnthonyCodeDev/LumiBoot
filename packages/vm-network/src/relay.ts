export interface RelayValidation {
  ok: boolean;
  url?: string;
  error?: string;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Valide une adresse de relais WISP personnelle.
 *
 * Seul le schéma `wss:` est accepté. `ws:` (non chiffré) n'est toléré que pour
 * un hôte localhost et uniquement si `allowInsecure` est activé (développement).
 * L'URL ne doit comporter ni identifiants (userinfo), ni fragment ; l'hôte est
 * obligatoire et le port reste optionnel.
 */
export function validateRelayUrl(
  raw: unknown,
  options: { allowInsecure?: boolean } = {},
): RelayValidation {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Adresse de relais invalide : une chaîne est attendue.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Adresse de relais vide.' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Adresse de relais mal formée.' };
  }

  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    return { ok: false, error: 'Seul le protocole « wss: » est autorisé.' };
  }

  if (url.protocol === 'ws:') {
    const allowInsecure = options.allowInsecure === true;
    if (!allowInsecure || !isLocalHostname(url.hostname)) {
      return {
        ok: false,
        error: 'Le protocole « ws: » (non chiffré) est réservé au développement localhost.',
      };
    }
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: "Les identifiants (userinfo) ne sont pas autorisés dans l'URL." };
  }

  if (url.hash !== '') {
    return { ok: false, error: 'Le fragment (« #… ») n’est pas autorisé.' };
  }

  if (url.hostname === '') {
    return { ok: false, error: 'Le nom d’hôte est obligatoire.' };
  }

  return { ok: true, url: url.href };
}
