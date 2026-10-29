import {
  createMemoryUserMediaStore,
  type UserMediaDescriptor,
  type UserMediaStore,
} from '@lumiboot/vm-assets';

/** IndexedDB only, nothing is sent to a server; memory fallback when IndexedDB is unavailable. */

const DB_NAME = 'lumiboot-user-media';
const DB_VERSION = 1;
const DESCRIPTORS = 'descriptors';
const BLOBS = 'blobs';

/** Raised when another tab holds a connection that prevents the schema upgrade. */
export class UserMediaStorageBlockedError extends Error {
  constructor() {
    super('IndexedDB is blocked by another tab. Close other LumiBoot tabs and retry.');
    this.name = 'UserMediaStorageBlockedError';
  }
}

export function isUserMediaStorageBlockedError(
  error: unknown,
): error is UserMediaStorageBlockedError {
  return error instanceof UserMediaStorageBlockedError;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      fail(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DESCRIPTORS)) {
        db.createObjectStore(DESCRIPTORS, { keyPath: 'ref' });
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    request.onsuccess = () => {
      const db = request.result;
      // The result may arrive after `onblocked` rejected the promise.
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Another tab asking for a migration must not be blocked by this one.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => fail(request.error ?? new Error('Unable to open IndexedDB.'));
    // `onblocked` never fires `onerror`: without this hook the promise hangs.
    request.onblocked = () => fail(new UserMediaStorageBlockedError());
  });
}

const MEDIA_FORMATS = new Set(['raw', 'iso']);
const INTEGRITIES = new Set(['verified', 'unverified']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Persisted descriptors are untrusted on read. */
export function isUserMediaDescriptor(value: unknown): value is UserMediaDescriptor {
  if (typeof value !== 'object' || value === null) return false;
  const { ref, displayName, fileName, format, size, integrity, sha256, importedAt } =
    value as Record<string, unknown>;
  return (
    isNonEmptyString(ref) &&
    isNonEmptyString(displayName) &&
    isNonEmptyString(fileName) &&
    typeof format === 'string' &&
    MEDIA_FORMATS.has(format) &&
    typeof size === 'number' &&
    Number.isInteger(size) &&
    size > 0 &&
    typeof integrity === 'string' &&
    INTEGRITIES.has(integrity) &&
    typeof importedAt === 'number' &&
    Number.isFinite(importedAt) &&
    (sha256 === undefined || typeof sha256 === 'string')
  );
}

function runTransaction<T>(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  build: (tx: IDBTransaction) => IDBRequest<T> | null,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (error) {
      fail(error);
      return;
    }

    let request: IDBRequest<T> | null = null;
    let value: T | undefined;
    try {
      request = build(tx);
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      fail(error);
      return;
    }

    if (request) {
      request.onsuccess = () => {
        value = request!.result;
      };
      request.onerror = () => fail(request!.error ?? new Error('IndexedDB request failed.'));
    }

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    tx.onerror = () => fail(tx.error ?? new Error('IndexedDB transaction failed.'));
    tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

export function createIndexedDbUserMediaStore(db: IDBDatabase): UserMediaStore {
  return {
    async get(ref) {
      const value = await runTransaction<unknown>(
        db,
        [DESCRIPTORS],
        'readonly',
        (tx) => tx.objectStore(DESCRIPTORS).get(ref) as IDBRequest<unknown>,
      );
      return isUserMediaDescriptor(value) ? value : null;
    },
    async list() {
      const value = await runTransaction<unknown[]>(
        db,
        [DESCRIPTORS],
        'readonly',
        (tx) => tx.objectStore(DESCRIPTORS).getAll() as IDBRequest<unknown[]>,
      );
      return (value ?? []).filter(isUserMediaDescriptor);
    },
    async put(descriptor, bytes) {
      await runTransaction(db, [DESCRIPTORS, BLOBS], 'readwrite', (tx) => {
        tx.objectStore(DESCRIPTORS).put(descriptor);
        tx.objectStore(BLOBS).put(bytes, descriptor.ref);
        return null;
      });
    },
    async getBytes(ref) {
      const value = await runTransaction<Blob>(
        db,
        [BLOBS],
        'readonly',
        (tx) => tx.objectStore(BLOBS).get(ref) as IDBRequest<Blob>,
      );
      return value ?? null;
    },
    async remove(ref) {
      await runTransaction(db, [DESCRIPTORS, BLOBS], 'readwrite', (tx) => {
        tx.objectStore(DESCRIPTORS).delete(ref);
        tx.objectStore(BLOBS).delete(ref);
        return null;
      });
    },
  };
}

let storePromise: Promise<UserMediaStore> | null = null;

/** Resolves the store once: IndexedDB when available, otherwise memory. */
export function getUserMediaStore(): Promise<UserMediaStore> {
  if (storePromise !== null) return storePromise;
  storePromise = (async () => {
    if (typeof indexedDB === 'undefined') return createMemoryUserMediaStore();
    try {
      const db = await openDatabase();
      return createIndexedDbUserMediaStore(db);
    } catch (error) {
      // A blocked database is transient: surface it so the caller can retry.
      if (isUserMediaStorageBlockedError(error)) throw error;
      return createMemoryUserMediaStore();
    }
  })();
  // Do not cache a rejection: closing the other tabs must let the next call retry.
  storePromise.catch(() => {
    storePromise = null;
  });
  return storePromise;
}

/** Resets the store resolution, for tests. */
export function resetUserMediaStoreForTests(): void {
  storePromise = null;
}
