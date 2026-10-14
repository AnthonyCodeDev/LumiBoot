export type AssetErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'ASSET_DOWNLOAD_FAILED'
  | 'ASSET_CHECKSUM_MISMATCH'
  | 'ASSET_SIZE_MISMATCH'
  | 'ASSET_ABORTED'
  | 'ASSET_CACHE_QUOTA_EXCEEDED'
  | 'ASSET_INVALID_MANIFEST';

export interface AssetErrorOptions {
  ref?: string;
  cause?: unknown;
}

export class AssetError extends Error {
  readonly code: AssetErrorCode;
  readonly ref: string | undefined;

  constructor(code: AssetErrorCode, message: string, options: AssetErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AssetError';
    this.code = code;
    this.ref = options.ref;
  }
}

export function isAssetError(value: unknown): value is AssetError {
  return value instanceof AssetError;
}
