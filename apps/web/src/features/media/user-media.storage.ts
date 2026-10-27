import {
  createMemoryUserMediaStore,
  type UserMediaDescriptor,
  type UserMediaStore,
} from '@lumiboot/vm-assets';

/**
 * Persistence for media imported by the user, in IndexedDB only: nothing is sent
 * to a server. Falls back to memory when IndexedDB is unavailable.
 */

const DB_NAME = 'lumiboot-user-media';
const DB_VERSION = 1;
const DESCRIPTORS = 'descriptors';
const BLOBS = 'blobs';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DESCRIPTORS)) {
        db.createObjectStore(DESCRIPTORS, { keyPath: 'ref' });
      }
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB.'));
  });
}

/** Runs a transaction and resolves with the built request result. Rejects on error. */
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

/** IndexedDB store; blobs are stored as-is. */
export function createIndexedDbUserMediaStore(db: IDBDatabase): UserMediaStore {
  return {
    async get(ref) {
      const value = await runTransaction<UserMediaDescriptor>(
        db,
        [DESCRIPTORS],
        'readonly',
        (tx) => tx.objectStore(DESCRIPTORS).get(ref) as IDBRequest<UserMediaDescriptor>,
      );
      return value ?? null;
    },
    async list() {
      const value = await runTransaction<UserMediaDescriptor[]>(
        db,
        [DESCRIPTORS],
        'readonly',
        (tx) => tx.objectStore(DESCRIPTORS).getAll() as IDBRequest<UserMediaDescriptor[]>,
      );
      return value ?? [];
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
    } catch {
      return createMemoryUserMediaStore();
    }
  })();
  return storePromise;
}

/** Resets the store resolution, for tests. */
export function resetUserMediaStoreForTests(): void {
  storePromise = null;
}
