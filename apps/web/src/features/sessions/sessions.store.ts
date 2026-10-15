import { create } from 'zustand';
import { getSystemById } from '@lumiboot/catalog';
import { SessionLifecycle, VMError, type SessionSnapshot } from '@lumiboot/vm-core';
import { selectEffectiveNetworkProfile, type NetworkMode } from '@lumiboot/vm-network';
import { createRegistry } from './registry';
import { resolveProxyConfig, resolveNetworkProfile } from '../../config/runtime';
import { getProxyRuntimeCredentials } from '../proxy/store';

const registry = createRegistry();
const lifecycles = new Map<string, SessionLifecycle>();
const unsubscribers = new Map<string, () => void>();
/** Ids détruits : interdit toute réinsertion par un snapshot tardif. */
const disposedIds = new Set<string>();

export interface SessionsState {
  sessions: Record<string, SessionSnapshot>;
  /**
   * Mode réseau **effectivement utilisé** au démarrage de chaque session
   * (résolu par `selectEffectiveNetworkProfile`, potentiellement
   * `local-proxy` via l'appairage automatique). Distinct du mode
   * configuré : sert au badge de la barre d'outils.
   */
  networkModes: Record<string, NetworkMode>;
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
  networkModes: {},
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
    const lifecycle = lifecycles.get(id);
    if (!lifecycle) return;
    // Le profil réseau est résolu au démarrage puis reste figé pour la session
    // (tout changement de mode exige un redémarrage de la session).
    // Sélection automatique : proxy réseau local appairé/connecté → `local-proxy`
    // (jeton runtime fusionné ici, jamais persisté dans `lumiboot.config.json`) ;
    // sinon mode de base (`browser-fetch` par défaut). `offline`/`user-relay`
    // restent des choix explicites respectés.
    const base = resolveNetworkProfile(lifecycle.system.id);
    const proxyConfig = resolveProxyConfig();
    const credentials = getProxyRuntimeCredentials();
    const network = selectEffectiveNetworkProfile(base, {
      enabled: proxyConfig.enabled,
      connected: credentials.proxyToken !== null,
      proxyUrl: credentials.proxyUrl,
      ...(credentials.proxyToken === null ? {} : { proxyToken: credentials.proxyToken }),
    });
    // Mémorise le mode effectif avant le démarrage : la barre d'outils affiche
    // ce qui tourne réellement, pas le mode configuré.
    set((s) => ({ networkModes: { ...s.networkModes, [id]: network.mode } }));
    await lifecycle.start(mountElement, { network });
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
        const networkModes = { ...state.networkModes };
        delete networkModes[id];
        return { sessions, networkModes };
      });
    }
  },
}));
