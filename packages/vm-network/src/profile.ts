import { z } from 'zod';
import { NETWORK_MODES, type NetworkMode } from './modes';
import { NetworkError } from './errors';

/** Configuration réseau d'une machine virtuelle. Aucun relais public par défaut. */
export interface NetworkProfile {
  mode: NetworkMode;
  relayUrl?: string;
}

export const defaultNetworkProfile: NetworkProfile = Object.freeze({
  mode: 'offline',
} satisfies NetworkProfile);

export const networkProfileSchema = z
  .object({
    mode: z.enum(NETWORK_MODES),
    relayUrl: z.string().min(1).optional(),
  })
  .strict();

export interface NetworkProfileValidation {
  ok: boolean;
  errors: string[];
  profile?: NetworkProfile;
}

type ParsedProfile = z.infer<typeof networkProfileSchema>;

function cleanProfile(parsed: ParsedProfile): NetworkProfile {
  const { mode, relayUrl } = parsed;
  if (mode === 'user-relay' && typeof relayUrl === 'string' && relayUrl.length > 0) {
    return { mode, relayUrl };
  }
  return { mode };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} : ${issue.message}` : issue.message;
  });
}

/** Valide puis nettoie un profil : `relayUrl` n'est conservé qu'en mode `user-relay`. */
export function normalizeNetworkProfile(input: unknown): NetworkProfile {
  const result = networkProfileSchema.safeParse(input);
  if (!result.success) {
    throw new NetworkError(
      'NETWORK_INVALID_PROFILE',
      `Profil réseau invalide : ${formatIssues(result.error).join(' ; ')}`,
      { cause: result.error },
    );
  }
  return cleanProfile(result.data);
}

/** Valide un profil sans lever : renvoie les erreurs et le profil nettoyé. */
export function validateNetworkProfile(input: unknown): NetworkProfileValidation {
  const result = networkProfileSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, errors: formatIssues(result.error) };
  }
  return { ok: true, errors: [], profile: cleanProfile(result.data) };
}
