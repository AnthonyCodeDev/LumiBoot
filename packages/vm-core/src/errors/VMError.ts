export type VMErrorCode =
  | 'PROVIDER_NOT_FOUND'
  | 'ENGINE_NOT_INTEGRATED'
  | 'IMAGE_MISSING'
  // The engine is integrated but the system media must be imported locally by
  // the user (LumiBoot distributes no proprietary resource).
  | 'MEDIA_REQUIRED'
  | 'UNSUPPORTED_ENVIRONMENT'
  | 'INVALID_TRANSITION'
  | 'START_FAILED'
  | 'NOT_IMPLEMENTED';

export interface VMErrorOptions {
  systemId?: string;
  cause?: unknown;
}

/**
 * Typed error that can be rendered as a user message. Engines never throw an
 * anonymous error: every failure carries a code usable by the UI.
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
