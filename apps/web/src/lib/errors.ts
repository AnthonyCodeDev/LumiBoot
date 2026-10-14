import { VMError, isVMError } from '@lumiboot/vm-core';

/** Traduit n'importe quelle erreur en message utilisateur, sans fuite technique. */
export function toUserMessage(error: unknown): string {
  if (isVMError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return 'Une erreur inattendue est survenue.';
}

/** Normalise une erreur inconnue en `VMError` typée. */
export function normalizeVMError(error: unknown, fallbackMessage: string): VMError {
  if (isVMError(error)) return error;
  return new VMError('START_FAILED', toUserMessage(error) || fallbackMessage, { cause: error });
}
