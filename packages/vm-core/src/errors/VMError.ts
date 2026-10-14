export type VMErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'ENGINE_NOT_INTEGRATED'
  | 'IMAGE_MISSING'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'INVALID_TRANSITION'
  | 'START_FAILED'
  | 'NOT_IMPLEMENTED';

export interface VMErrorOptions {
  systemId?: string;
  cause?: unknown;
}

/**
 * Erreur typée et traduisible en message utilisateur. Les moteurs ne lèvent
 * jamais d'erreur anonyme : chaque échec porte un code exploitable par l'UI.
 */
export class VMError extends Error {
  readonly code: VMErrorCode;
  readonly systemId: string | undefined;

  constructor(code: VMErrorCode, message: string, options: VMErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'VMError';
    this.code = code;
    this.systemId = options.systemId;
  }
}

export function isVMError(value: unknown): value is VMError {
  return value instanceof VMError;
}
