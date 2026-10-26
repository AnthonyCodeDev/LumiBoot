import { VMError, isVMError } from '@lumiboot/vm-core';

/** Turns any error into a user message, without leaking internals. */
export function toUserMessage(error: unknown): string {
  if (isVMError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'An unexpected error occurred.';
}

/** Normalizes an unknown error into a typed `VMError`. */
export function normalizeVMError(error: unknown, fallbackMessage: string): VMError {
  if (isVMError(error)) return error;
  return new VMError('START_FAILED', toUserMessage(error) || fallbackMessage, { cause: error });
}
