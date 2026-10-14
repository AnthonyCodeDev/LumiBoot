export type StorageErrorCode =
  | 'STORAGE_NOT_FOUND'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_CORRUPTED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_READ_FAILED'
  | 'STORAGE_VERSION_MISMATCH';

export interface StorageErrorOptions {
  key?: string;
  cause?: unknown;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly key: string | undefined;

  constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
    this.key = options.key;
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return value instanceof StorageError;
}
