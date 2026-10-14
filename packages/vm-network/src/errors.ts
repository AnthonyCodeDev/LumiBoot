export type NetworkErrorCode =
  | 'NETWORK_INVALID_PROFILE'
  | 'NETWORK_INVALID_RELAY_URL'
  | 'NETWORK_UNSUPPORTED_MODE'
  | 'NETWORK_TRANSPORT_FAILED'
  | 'NETWORK_ABORTED'
  | 'NETWORK_CLEANUP_FAILED';

export interface NetworkErrorOptions {
  cause?: unknown;
}

/** Erreur normalisée du sous-système réseau, porteuse d'un code stable. */
export class NetworkError extends Error {
  readonly code: NetworkErrorCode;

  constructor(code: NetworkErrorCode, message: string, options: NetworkErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NetworkError';
    this.code = code;
  }
}

export function isNetworkError(value: unknown): value is NetworkError {
  return value instanceof NetworkError;
}
