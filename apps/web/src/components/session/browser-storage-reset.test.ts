import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRepairReport, NOT_AVAILABLE, repairBrowserStorage } from './browser-storage-reset';
import { DEV_ORIGIN } from '../../test/fixtures';

const SW_KEY = 'serviceWorker';

interface StubOptions {
  registrations?: number;
  cacheNames?: string[];
  getRegistrationsError?: Error;
  unregisterRejectsAt?: number;
  cachesError?: Error;
}

/** Stubs the two origin-scoped APIs and returns a restore function. */
function stubBrowserStorage(options: StubOptions = {}): {
  unregistered: string[];
  deleted: string[];
  restore: () => void;
} {
  const unregistered: string[] = [];
  const deleted: string[] = [];
  const count = options.registrations ?? 0;
  const registrations = Array.from({ length: count }, (_value, index) => ({
    scope: `${DEV_ORIGIN}/other-${index}/`,
    unregister: async (): Promise<boolean> => {
      if (options.unregisterRejectsAt === index) throw new Error(`unregister ${index} failed`);
      unregistered.push(String(index));
      return true;
    },
  }));

  const container = {
    getRegistrations: async () => {
      if (options.getRegistrationsError !== undefined) throw options.getRegistrationsError;
      return registrations;
    },
  };

  const storage = {
    keys: async () => {
      if (options.cachesError !== undefined) throw options.cachesError;
      return options.cacheNames ?? [];
    },
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  };

  const previous = Object.getOwnPropertyDescriptor(navigator, SW_KEY);
  Object.defineProperty(navigator, SW_KEY, { configurable: true, value: container });
  vi.stubGlobal('caches', storage);

  return {
    unregistered,
    deleted,
    restore: () => {
      if (previous === undefined) {
        Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, SW_KEY);
      } else {
        Object.defineProperty(navigator, SW_KEY, previous);
      }
      vi.unstubAllGlobals();
    },
  };
}

function hideBrowserStorage(): () => void {
  const previous = Object.getOwnPropertyDescriptor(navigator, SW_KEY);
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, SW_KEY);
  vi.stubGlobal('caches', undefined);
  return () => {
    if (previous !== undefined) Object.defineProperty(navigator, SW_KEY, previous);
    vi.unstubAllGlobals();
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('repairBrowserStorage', () => {
  it('unregisters every service worker and clears every cache', async () => {
    const stub = stubBrowserStorage({ registrations: 2, cacheNames: ['other-app-cache'] });
    try {
      const outcome = await repairBrowserStorage();

      expect(outcome).toEqual({ serviceWorkers: 2, caches: 1, problems: [] });
      expect(stub.unregistered).toEqual(['0', '1']);
      expect(stub.deleted).toEqual(['other-app-cache']);
      expect(formatRepairReport(outcome)).toBe(
        '2 service worker(s) unregistered · 1 cache(s) cleared',
      );
    } finally {
      stub.restore();
    }
  });

  it('reports 0/0 instead of staying silent', async () => {
    const stub = stubBrowserStorage();
    try {
      const outcome = await repairBrowserStorage();

      expect(formatRepairReport(outcome)).toBe(
        '0 service worker(s) unregistered · 0 cache(s) cleared',
      );
    } finally {
      stub.restore();
    }
  });

  it('reports unavailable APIs without throwing', async () => {
    const restore = hideBrowserStorage();
    try {
      const outcome = await repairBrowserStorage();

      expect(outcome.serviceWorkers).toBe(0);
      expect(outcome.caches).toBe(0);
      const text = formatRepairReport(outcome);
      expect(text).toContain('0 service worker(s) unregistered · 0 cache(s) cleared');
      expect(text).toContain(`service worker API ${NOT_AVAILABLE}`);
      expect(text).toContain(`Cache Storage API ${NOT_AVAILABLE}`);
    } finally {
      restore();
    }
  });

  it('captures a throwing API as short readable text', async () => {
    const stub = stubBrowserStorage({
      registrations: 2,
      cacheNames: ['a'],
      getRegistrationsError: new Error('SecurityError: blocked by policy'),
      unregisterRejectsAt: 1,
    });
    try {
      const outcome = await repairBrowserStorage();

      expect(outcome.serviceWorkers).toBe(0);
      expect(outcome.problems.join(' ')).toContain('blocked by policy');
      expect(formatRepairReport(outcome)).toContain('blocked by policy');
    } finally {
      stub.restore();
    }
  });

  it('keeps the successful unregisters when one registration fails', async () => {
    const stub = stubBrowserStorage({ registrations: 2, unregisterRejectsAt: 1 });
    try {
      const outcome = await repairBrowserStorage();

      expect(outcome.serviceWorkers).toBe(1);
      expect(outcome.problems.join(' ')).toContain('unregister 1 failed');
    } finally {
      stub.restore();
    }
  });

  it('never touches localStorage, cookies or IndexedDB', async () => {
    const stub = stubBrowserStorage({ registrations: 1, cacheNames: ['x'] });
    try {
      localStorage.setItem('lumiboot', 'kept');
      const cookieBefore = document.cookie;
      const setItem = vi.spyOn(Storage.prototype, 'setItem');

      await repairBrowserStorage();

      expect(localStorage.getItem('lumiboot')).toBe('kept');
      expect(document.cookie).toBe(cookieBefore);
      expect(setItem).not.toHaveBeenCalled();
      setItem.mockRestore();
    } finally {
      stub.restore();
    }
  });
});
