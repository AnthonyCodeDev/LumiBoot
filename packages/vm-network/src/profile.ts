import { z } from 'zod';
import { NETWORK_MODES, type NetworkMode } from './modes';
import { NetworkError } from './errors';

export interface NetworkProfile {
  mode: NetworkMode;
  relayUrl?: string;
  proxyUrl?: string;
  /** Runtime only; the public config rejects it and never persists it. */
  proxyToken?: string;
}

export const defaultNetworkProfile: NetworkProfile = Object.freeze({
  mode: 'offline',
} satisfies NetworkProfile);

export const networkProfileSchema = z
  .object({
    mode: z.enum(NETWORK_MODES),
    relayUrl: z.string().min(1).optional(),
    proxyUrl: z.string().min(1).optional(),
    proxyToken: z.string().min(1).optional(),
  })
  .strict();

export interface NetworkProfileValidation {
  ok: boolean;
  errors: string[];
  profile?: NetworkProfile;
}

type ParsedProfile = z.infer<typeof networkProfileSchema>;

function cleanProfile(parsed: ParsedProfile): NetworkProfile {
  const { mode, relayUrl, proxyUrl, proxyToken } = parsed;
  if (mode === 'user-relay' && typeof relayUrl === 'string' && relayUrl.length > 0) {
    return { mode, relayUrl };
  }
  if (mode === 'local-proxy') {
    const cleaned: NetworkProfile = { mode };
    if (typeof proxyUrl === 'string' && proxyUrl.length > 0) {
      cleaned.proxyUrl = proxyUrl;
    }
    if (typeof proxyToken === 'string' && proxyToken.length > 0) {
      cleaned.proxyToken = proxyToken;
    }
    return cleaned;
  }
  return { mode };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
}

export function normalizeNetworkProfile(input: unknown): NetworkProfile {
  const result = networkProfileSchema.safeParse(input);
  if (!result.success) {
    throw new NetworkError(
      'NETWORK_INVALID_PROFILE',
      `Invalid network profile: ${formatIssues(result.error).join('; ')}`,
      { cause: result.error },
    );
  }
  return cleanProfile(result.data);
}

export function validateNetworkProfile(input: unknown): NetworkProfileValidation {
  const result = networkProfileSchema.safeParse(input);
  if (!result.success) {
    return { ok: false, errors: formatIssues(result.error) };
  }
  return { ok: true, errors: [], profile: cleanProfile(result.data) };
}
