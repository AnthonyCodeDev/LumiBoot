import { create } from 'zustand';
import type { VMMedia } from '@lumiboot/contracts';
import { getSystemById } from '@lumiboot/catalog';
import { SessionLifecycle, VMError, type SessionSnapshot } from '@lumiboot/vm-core';
import { selectEffectiveNetworkProfile, type NetworkMode } from '@lumiboot/vm-network';
import { createRegistry } from './registry';
import { resolveProxyConfig, resolveNetworkProfile } from '../../config/runtime';
import { getProxyRuntimeCredentials } from '../proxy/store';
import { getUserMediaStore } from '../media/user-media.storage';
import { normalizeVMError } from '../../lib/errors';

const registry = createRegistry();
const lifecycles = new Map<string, SessionLifecycle>();
const unsubscribers = new Map<string, () => void>();
/** Ids détruits : interdit toute réinsertion par un snapshot tardif. */
const disposedIds = new Set<string>();

/**
 * Ressource média (URL de blob) rattachée à une SESSION, jamais à un système.
 *
 * Le `controller` identifie la génération de boot propriétaire : seule la
 * génération qui a réellement créé l'URL peut la révoquer. Deux VM du même OS
 * possèdent donc chacune leur URL, et libérer l'une ne touche jamais l'autre.
 */
interface SessionMediaResource {
  readonly url: string;
  readonly controller: AbortController;
}

/** URL de blob des médias importés, indexées par identifiant de SESSION. */
const mediaObjectUrls = new Map<string, SessionMediaResource>();
/** Génération de boot courante par session. */
const bootGenerations = new Map<string, number>();
/** Controller du boot en cours par session (annule un boot supplanté). */
const bootControllers = new Map<string, AbortController>();

function revokeUrl(url: string): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

/** Révoque l'unique URL de blob appartenant à cette session, si elle existe. */
function releaseSessionMedia(sessionId: string): void {
  const resource = mediaObjectUrls.get(sessionId);
  if (resource === undefined) return;
  mediaObjectUrls.delete(sessionId);
  revokeUrl(resource.url);
}

/**
 * Révoque l'URL d'une session UNIQUEMENT si elle appartient encore à la
 * génération de boot donnée. Un boot supplanté ne révoque jamais l'URL de sa
 * remplaçante.
 */
function releaseMediaOwnedBy(sessionId: string, controller: AbortController): void {
  const resource = mediaObjectUrls.get(sessionId);
  if (resource === undefined || resource.controller !== controller) return;
  mediaObjectUrls.delete(sessionId);
  revokeUrl(resource.url);
}

/**
 * Démarre une nouvelle génération de boot pour une session : annule le boot
 * précédent (s'il existe) et libère le média qu'il possédait encore.
 */
function beginBoot(sessionId: string): { generation: number; controller: AbortController } {
  const previous = bootControllers.get(sessionId);
  if (previous !== undefined) {
    previous.abort();
    releaseMediaOwnedBy(sessionId, previous);
  }
  const generation = (bootGenerations.get(sessionId) ?? 0) + 1;
  bootGenerations.set(sessionId, generation);
  const controller = new AbortController();
  bootControllers.set(sessionId, controller);
  return { generation, controller };
}

/**
 * Invalide la génération de boot courante (stop/dispose) : plus aucun `await`
 * en vol ne pourra publier d'URL ni démarrer la session.
 */
function invalidateBoot(sessionId: string): void {
  bootGenerations.set(sessionId, (bootGenerations.get(sessionId) ?? 0) + 1);
  const controller = bootControllers.get(sessionId);
  if (controller === undefined) return;
  controller.abort();
  bootControllers.delete(sessionId);
}

/** Vrai tant que la session et la génération de boot sont toujours valides. */
function isBootCurrent(
  sessionId: string,
  generation: number,
  controller: AbortController,
): boolean {
  return (
    !disposedIds.has(sessionId) &&
    lifecycles.has(sessionId) &&
    bootGenerations.get(sessionId) === generation &&
    bootControllers.get(sessionId) === controller &&
    !controller.signal.aborted
  );
}

type UserMediaResolution =
  { status: 'ready'; media: VMMedia } | { status: 'missing' } | { status: 'superseded' };

/**
 * Résout le média local d'un système `user-import` : lit le blob importé et
 * fabrique une URL locale pour v86. Aucune donnée ne quitte le navigateur.
 * Retourne `missing` si aucun média n'a été importé (le provider échouera alors
 * honnêtement avec `MEDIA_REQUIRED`).
 *
 * La session ET sa génération de boot sont revalidées après CHAQUE `await`
 * (résolution IndexedDB, lecture des octets). Une résolution devenue obsolète
 * (session détruite, arrêtée, ou boot supplanté) ne publie jamais d'URL — et
 * révoque immédiatement toute URL qu'elle viendrait de créer.
 */
async function resolveUserMedia(
  sessionId: string,
  systemId: string,
  controller: AbortController,
  isCurrent: () => boolean,
): Promise<UserMediaResolution> {
  const store = await getUserMediaStore();
  if (!isCurrent()) return { status: 'superseded' };
  const descriptor = await store.get(systemId);
  if (!isCurrent()) return { status: 'superseded' };
  const bytes = await store.getBytes(systemId);
  if (!isCurrent()) return { status: 'superseded' };
  if (!descriptor || !bytes || bytes.size <= 0) return { status: 'missing' };
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { status: 'missing' };
  }
  const url = URL.createObjectURL(bytes);
  if (!isCurrent()) {
    // Arrivée tardive : la session n'est plus propriétaire, on révoque aussitôt.
    revokeUrl(url);
    return { status: 'superseded' };
  }
  // Un (re)démarrage de la même session remplace sa propre URL : l'ancienne est
  // révoquée pour ne jamais accumuler deux blobs pour une même session.
  releaseSessionMedia(sessionId);
  mediaObjectUrls.set(sessionId, { url, controller });
  return {
    status: 'ready',
    media: { kind: 'disk', url, size: bytes.size, format: descriptor.format },
  };
}

/** Construit un snapshot d'erreur honnête à partir de n'importe quelle erreur. */
function toErrorSnapshot(snapshot: SessionSnapshot, error: unknown): SessionSnapshot {
  const vmError = normalizeVMError(error, 'Le démarrage de la session a échoué.');
  return {
    ...snapshot,
    state: 'error',
    error: { code: vmError.code, message: vmError.message },
  };
}

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
      // Une session en erreur ne réutilisera plus son média : on le libère.
      if (snapshot.state === 'error') releaseSessionMedia(lifecycle.id);
      set((state) => ({ sessions: { ...state.sessions, [lifecycle.id]: snapshot } }));
    });
    unsubscribers.set(lifecycle.id, unsubscribe);
    set((state) => ({ sessions: { ...state.sessions, [lifecycle.id]: lifecycle.snapshot } }));
    return lifecycle.id;
  },
  boot: async (id, mountElement) => {
    const lifecycle = lifecycles.get(id);
    if (!lifecycle || disposedIds.has(id)) return;

    const { generation, controller } = beginBoot(id);
    const isCurrent = (): boolean => isBootCurrent(id, generation, controller);

    try {
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
      if (!isCurrent()) return;

      // Mémorise le mode effectif avant le démarrage : la barre d'outils affiche
      // ce qui tourne réellement, pas le mode configuré.
      set((s) => ({ networkModes: { ...s.networkModes, [id]: network.mode } }));

      // Système à média importé : on branche le disque local fourni par
      // l'utilisateur. Absent -> le provider échoue avec `MEDIA_REQUIRED`.
      let media: VMMedia | undefined;
      if (lifecycle.system.mediaStrategy === 'user-import') {
        const resolution = await resolveUserMedia(id, lifecycle.system.id, controller, isCurrent);
        if (resolution.status === 'superseded') {
          releaseMediaOwnedBy(id, controller);
          return;
        }
        media = resolution.status === 'ready' ? resolution.media : undefined;
      }
      if (!isCurrent()) {
        releaseMediaOwnedBy(id, controller);
        return;
      }

      await lifecycle.start(mountElement, {
        network,
        ...(media === undefined ? {} : { media }),
        // Le signal externe annule le démarrage si le boot est supplanté.
        signal: controller.signal,
      });
    } catch (error) {
      releaseMediaOwnedBy(id, controller);
      // Un échec asynchrone (IndexedDB, réseau) survenu avant/après
      // `lifecycle.start` doit devenir un statut de session observable, jamais
      // une promesse rejetée silencieuse. Une session déjà supplantée n'est
      // jamais écrasée (pas de clobber de la nouvelle session).
      if (!isCurrent()) return;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: toErrorSnapshot(state.sessions[id] ?? lifecycle.snapshot, error),
        },
      }));
    }
  },
  stop: async (id) => {
    const lifecycle = lifecycles.get(id);
    if (!lifecycle) {
      releaseSessionMedia(id);
      return;
    }
    // Invalide toute résolution de média en vol et interdit une arrivée tardive
    // avant même de commencer l'arrêt.
    invalidateBoot(id);
    try {
      await lifecycle.stop();
    } finally {
      releaseSessionMedia(id);
    }
  },
  dispose: async (id) => {
    const lifecycle = lifecycles.get(id);
    if (!lifecycle) {
      // Session déjà retirée : on garantit malgré tout l'absence de fuite.
      disposedIds.add(id);
      releaseSessionMedia(id);
      bootGenerations.delete(id);
      bootControllers.delete(id);
      return;
    }
    disposedIds.add(id);
    invalidateBoot(id);
    try {
      await lifecycle.dispose();
    } finally {
      releaseSessionMedia(id);
      bootGenerations.delete(id);
      bootControllers.delete(id);
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
