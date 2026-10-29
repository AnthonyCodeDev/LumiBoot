/** Removes service workers and Cache Storage of this origin: another project on the same
 * dev origin can intercept disk range reads. No localStorage, cookies or IndexedDB. */

export interface RepairOutcome {
  readonly serviceWorkers: number;
  readonly caches: number;
  /** Short, user-readable problems; empty when everything went cleanly. */
  readonly problems: readonly string[];
}

/** Exact wording checked by the UI and the tests. */
export const NOT_AVAILABLE = 'not available';

function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  return singleLine.length === 0 ? 'unknown error' : singleLine.slice(0, 160);
}

function serviceWorkerContainer(): ServiceWorkerContainer | null {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const container = navigator.serviceWorker;
  if (container === null || typeof container.getRegistrations !== 'function') return null;
  return container;
}

function cacheStorage(): CacheStorage | null {
  if (typeof caches === 'undefined') return null;
  if (typeof caches.keys !== 'function' || typeof caches.delete !== 'function') return null;
  return caches;
}

/** Never rejects: failures are folded into the returned outcome. */
export async function repairBrowserStorage(): Promise<RepairOutcome> {
  let serviceWorkers = 0;
  let clearedCaches = 0;
  const problems: string[] = [];

  const container = serviceWorkerContainer();
  if (container === null) {
    problems.push(`service worker API ${NOT_AVAILABLE}`);
  } else {
    try {
      const registrations = await container.getRegistrations();
      const results = await Promise.allSettled(
        registrations.map((registration) => registration.unregister()),
      );
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          // `unregister()` resolves `false` when the browser refused.
          if (result.value !== false) serviceWorkers += 1;
          return;
        }
        problems.push(`service worker ${index + 1}: ${shortMessage(result.reason)}`);
      });
    } catch (error) {
      problems.push(`service worker: ${shortMessage(error)}`);
    }
  }

  const storage = cacheStorage();
  if (storage === null) {
    problems.push(`Cache Storage API ${NOT_AVAILABLE}`);
  } else {
    try {
      const names = await storage.keys();
      for (const name of names) {
        try {
          if (await storage.delete(name)) clearedCaches += 1;
        } catch (error) {
          problems.push(`cache ${name}: ${shortMessage(error)}`);
        }
      }
    } catch (error) {
      problems.push(`cache storage: ${shortMessage(error)}`);
    }
  }

  return { serviceWorkers, caches: clearedCaches, problems };
}

/** One compact line: `2 service worker(s) unregistered · 1 cache(s) cleared`. */
export function formatRepairReport(outcome: RepairOutcome): string {
  const counts = `${outcome.serviceWorkers} service worker(s) unregistered · ${outcome.caches} cache(s) cleared`;
  if (outcome.problems.length === 0) return counts;
  return `${counts} · ${outcome.problems.join(' · ')}`;
}
