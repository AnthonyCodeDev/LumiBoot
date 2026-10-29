import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserMediaDescriptor } from '@lumiboot/vm-assets';
import {
  UserMediaStorageBlockedError,
  createIndexedDbUserMediaStore,
  getUserMediaStore,
  isUserMediaDescriptor,
  resetUserMediaStoreForTests,
} from './user-media.storage';

const descriptor: UserMediaDescriptor = {
  ref: 'custom-image',
  displayName: 'Custom image',
  fileName: 'custom.iso',
  format: 'iso',
  size: 4096,
  integrity: 'unverified',
  importedAt: 1_700_000_000_000,
};

interface FakeRequest {
  result?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
}

interface FakeTransaction {
  oncomplete?: () => void;
  onerror?: () => void;
  onabort?: () => void;
}

/** Minimal IDBDatabase double whose request handlers are settled by the test. */
function fakeDatabase(records: unknown[]): { db: IDBDatabase; settle: () => void } {
  const requests: FakeRequest[] = [];
  let transaction: FakeTransaction | undefined;

  const makeRequest = (result: unknown): FakeRequest => {
    const request: FakeRequest = { result };
    requests.push(request);
    return request;
  };

  const db = {
    transaction: () => {
      const created = {
        objectStore: () => ({
          get: (ref: string) =>
            makeRequest(
              records.find((record) => (record as { ref?: unknown } | null)?.ref === ref),
            ),
          getAll: () => makeRequest(records),
        }),
      };
      transaction = created as FakeTransaction;
      return created;
    },
  } as unknown as IDBDatabase;

  return {
    db,
    settle: () => {
      for (const request of requests) request.onsuccess?.();
      transaction?.oncomplete?.();
    },
  };
}

describe('isUserMediaDescriptor', () => {
  it('accepts a persisted descriptor', () => {
    expect(isUserMediaDescriptor(descriptor)).toBe(true);
  });

  it('rejects a corrupted entry', () => {
    expect(isUserMediaDescriptor(null)).toBe(false);
    expect(isUserMediaDescriptor('garbage')).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, ref: '' })).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, format: 'qcow2' })).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, size: 0 })).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, size: 1.5 })).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, integrity: 'unknown' })).toBe(false);
    expect(isUserMediaDescriptor({ ...descriptor, importedAt: Number.NaN })).toBe(false);
  });
});

describe('createIndexedDbUserMediaStore', () => {
  it('drops corrupted entries from list()', async () => {
    const { db, settle } = fakeDatabase([descriptor, { ref: 'broken', size: 0 }, null, 'garbage']);
    const store = createIndexedDbUserMediaStore(db);

    const pending = store.list();
    settle();

    expect(await pending).toEqual([descriptor]);
  });

  it('returns null from get() for a corrupted entry', async () => {
    const { db, settle } = fakeDatabase([{ ...descriptor, size: -1 }]);
    const store = createIndexedDbUserMediaStore(db);

    const pending = store.get(descriptor.ref);
    settle();

    expect(await pending).toBeNull();
  });

  it('still returns a valid entry from get()', async () => {
    const { db, settle } = fakeDatabase([descriptor]);
    const store = createIndexedDbUserMediaStore(db);

    const pending = store.get(descriptor.ref);
    settle();

    expect(await pending).toEqual(descriptor);
  });
});

describe('getUserMediaStore', () => {
  afterEach(() => {
    resetUserMediaStoreForTests();
    vi.unstubAllGlobals();
  });

  it('rejects with an actionable error when IndexedDB is blocked by another tab', async () => {
    type OpenListeners = { onblocked?: (event: Event) => void };
    const request: OpenListeners = {};
    const open = vi.fn(() => {
      // Fired instead of `error`: without a handler the open request hangs forever.
      queueMicrotask(() => request.onblocked?.(new Event('blocked')));
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal('indexedDB', { open });

    await expect(getUserMediaStore()).rejects.toBeInstanceOf(UserMediaStorageBlockedError);
    await expect(getUserMediaStore()).rejects.toThrow(/blocked by another tab/i);
    // The rejection is not cached: closing the other tabs must allow a retry.
    expect(open).toHaveBeenCalledTimes(2);
  });
});
