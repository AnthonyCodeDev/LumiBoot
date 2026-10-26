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
/** Destroyed IDs: forbids any re-insertion through a late snapshot. */
const disposedIds = new Set<string>();

/**
 * Media resource (blob URL) attached to a SESSION, never to a system.
 *
 * The `controller` identifies the owning boot generation: only the generation
 * that really created the URL may revoke it. Two VMs of the same OS therefore
 * each own their URL, and releasing one never touches the other.
 */
interface SessionMediaResource {
  readonly url: string;
  readonly controller: AbortController;
}

/** Blob URLs of imported media, indexed by SESSION ID. */
const mediaObjectUrls = new Map<string, SessionMediaResource>();
/** Current boot generation per session. */
const bootGenerations = new Map<string, number>();
/** Controller of the running boot per session (cancels a superseded boot). */
const bootControllers = new Map<string, AbortController>();

function revokeUrl(url: string): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

/** Revokes the single blob URL owned by this session, when it exists. */
function releaseSessionMedia(sessionId: string): void {
  const resource = mediaObjectUrls.get(sessionId);
  if (resource === undefined) return;
  mediaObjectUrls.delete(sessionId);
  revokeUrl(resource.url);
}

/**
 * Revokes a session URL ONLY when it still belongs to the given boot generation.
 * A superseded boot never revokes its replacement's URL.
 */
function releaseMediaOwnedBy(sessionId: string, controller: AbortController): void {
  const resource = mediaObjectUrls.get(sessionId);
  if (resource === undefined || resource.controller !== controller) return;
  mediaObjectUrls.delete(sessionId);
  revokeUrl(resource.url);
}

/**
 * Starts a new boot generation for a session: cancels the previous boot (when it
 * exists) and releases the media it still owned.
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
 * Invalidates the current boot generation (stop/dispose): no in-flight `await`
 * can publish a URL or start the session anymore.
 */
function invalidateBoot(sessionId: string): void {
  bootGenerations.set(sessionId, (bootGenerations.get(sessionId) ?? 0) + 1);
  const controller = bootControllers.get(sessionId);
  if (controller === undefined) return;
  controller.abort();
  bootControllers.delete(sessionId);
}

/** True while the session and the boot generation are still valid. */
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
 * Resolves the local media of a `user-import` system: reads the imported blob and
 * builds a local URL for v86. No data leaves the browser. Returns `missing` when
 * no media was imported (the provider then fails honestly with `MEDIA_REQUIRED`).
 *
 * The session AND its boot generation are revalidated after EVERY `await`
 * (IndexedDB resolution, byte read). A resolution that became stale (session
 * destroyed, stopped, or boot superseded) never publishes a URL — and immediately
 * revokes any URL it just created.
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
    // Late arrival: the session no longer owns it, revoke immediately.
    revokeUrl(url);
    return { status: 'superseded' };
  }
  // A (re)start of the same session replaces its own URL: the previous one is
  // revoked so two blobs never pile up for one session.
  releaseSessionMedia(sessionId);
  mediaObjectUrls.set(sessionId, { url, controller });
  return {
    status: 'ready',
    media: { kind: 'disk', url, size: bytes.size, format: descriptor.format },
  };
}

/** Builds an honest error snapshot from any error. */
function toErrorSnapshot(snapshot: SessionSnapshot, error: unknown): SessionSnapshot {
  const vmError = normalizeVMError(error, 'The session failed to start.');
  return {
    ...snapshot,
    state: 'error',
    error: { code: vmError.code, message: vmError.message },
  };
}

export interface SessionsState {
  sessions: Record<string, SessionSnapshot>;
  /**
   * Network mode **actually used** when each session boots (resolved by
   * `selectEffectiveNetworkProfile`, possibly `local-proxy` through automatic
   * pairing). Distinct from the configured mode: used by the toolbar badge.
   */
  networkModes: Record<string, NetworkMode>;
  create: (systemId: string) => string;
  boot: (id: string, mountElement: HTMLElement) => Promise<void>;
  stop: (id: string) => Promise<void>;
  dispose: (id: string) => Promise<void>;
}

/**
 * The store only relays the lifecycle managed by `SessionLifecycle` (vm-core).
 * No VM state logic is duplicated on the React side.
 */
export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: {},
  networkModes: {},
  create: (systemId) => {
    const system = getSystemById(systemId);
    if (!system) {
      throw new VMError('START_FAILED', `Unknown system: "${systemId}".`, { systemId });
    }
    const lifecycle = new SessionLifecycle(system, registry);
    lifecycles.set(lifecycle.id, lifecycle);
    const unsubscribe = lifecycle.subscribe((snapshot) => {
      // A kept listener must never re-insert a destroyed session.
      if (disposedIds.has(lifecycle.id)) return;
      // A session in error will not reuse its media: release it.
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
      // The network profile is resolved at boot and then frozen for the session
      // (any mode change requires restarting the session).
      // Automatic selection: paired/connected local network proxy → `local-proxy`
      // (runtime token merged here, never persisted in `lumiboot.config.json`);
      // otherwise the base mode (`browser-fetch` by default). `offline`/`user-relay`
      // remain explicit choices and are respected.
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

      // Records the effective mode before boot: the toolbar shows what really
      // runs, not the configured mode.
      set((s) => ({ networkModes: { ...s.networkModes, [id]: network.mode } }));

      // System with imported media: wire the local disk provided by the user.
      // Missing -> the provider fails with `MEDIA_REQUIRED`.
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
        // The external signal cancels the boot when it is superseded.
        signal: controller.signal,
      });
    } catch (error) {
      releaseMediaOwnedBy(id, controller);
      // An asynchronous failure (IndexedDB, network) before or after
      // `lifecycle.start` must become an observable session status, never a
      // silently rejected promise. A session that was already superseded is never
      // overwritten (no clobbering of the new session).
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
    // Invalidates any in-flight media resolution and forbids a late arrival
    // before the stop even begins.
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
      // Session already removed: still guarantee the absence of a leak.
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
