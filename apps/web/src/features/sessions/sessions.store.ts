import { create } from 'zustand';
import { getSystemById } from '@lumiboot/catalog';
import { SessionLifecycle, VMError, type SessionSnapshot } from '@lumiboot/vm-core';
import { createRegistry } from './registry';

const registry = createRegistry();
const lifecycles = new Map<string, SessionLifecycle>();
const unsubscribers = new Map<string, () => void>();
/** Ids détruits : interdit toute réinsertion par un snapshot tardif. */
const disposedIds = new Set<string>();

export interface SessionsState {
  sessions: Record<string, SessionSnapshot>;
  create: (systemId: string) => string;
  boot: (id: string, mountElement: HTMLElement) => Promise<void>;
  stop: (id: string) => Promise<void>;
  dispose: (id: string) => Promise<void>;
}

/**
 * Le store ne fait que relayer le cycle de vie géré par `SessionLifecycle`
 * (vm-core). Aucune logique d'état de VM n'est dupliquée côté React.
 */
export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: {},
  create: (systemId) => {
    const system = getSystemById(systemId);
    if (!system) {
      throw new VMError('START_FAILED', `Système inconnu : « ${systemId} ».`, { systemId });
    }
    const lifecycle = new SessionLifecycle(system, registry);
    lifecycles.set(lifecycle.id, lifecycle);
    const unsubscribe = lifecycle.subscribe((snapshot) => {
      // Un listener conservé ne doit jamais réinsérer une session détruite.
      if (disposedIds.has(lifecycle.id)) return;
      set((state) => ({ sessions: { ...state.sessions, [lifecycle.id]: snapshot } }));
    });
    unsubscribers.set(lifecycle.id, unsubscribe);
    set((state) => ({ sessions: { ...state.sessions, [lifecycle.id]: lifecycle.snapshot } }));
    return lifecycle.id;
  },
  boot: async (id, mountElement) => {
    await lifecycles.get(id)?.start(mountElement);
  },
  stop: async (id) => {
    await lifecycles.get(id)?.stop();
  },
  dispose: async (id) => {
    const lifecycle = lifecycles.get(id);
    if (!lifecycle) return;
    disposedIds.add(id);
    try {
      await lifecycle.dispose();
    } finally {
      unsubscribers.get(id)?.();
      unsubscribers.delete(id);
      lifecycles.delete(id);
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[id];
        return { sessions };
      });
    }
  },
}));
