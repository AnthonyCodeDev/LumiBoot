import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemById } from '@lumiboot/catalog';

/** Engine, runtime config, proxy credentials and media storage are doubles. */

const mocks = vi.hoisted(() => {
  interface FakeInstance {
    id: string;
    providerId: string;
    systemId: string;
    config: { signal?: AbortSignal; media?: { url: string } } | undefined;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    subscribe: (listener: (event: unknown) => void) => () => void;
    emit: (event: unknown) => void;
  }

  const instances: FakeInstance[] = [];
  const getUserMediaStore = vi.fn();
  const engine = {
    id: 'fake-engine',
    capabilities: () => ({
      runtime: 'browser',
      architectures: ['i386'],
      ramSnapshots: false,
      diskSnapshots: false,
      partialDownload: true,
      resumable: false,
      configurableMemory: true,
    }),
    canRun: () => true,
    start: vi.fn(async (os: { id: string }, _mount: unknown, config: FakeInstance['config']) => {
      const listeners = new Set<(event: unknown) => void>();
      const instance: FakeInstance = {
        id: `instance-${instances.length + 1}`,
        providerId: 'fake-engine',
        systemId: os.id,
        config,
        stop: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        emit: (event) => {
          for (const listener of listeners) listener(event);
        },
      };
      instances.push(instance);
      return instance;
    }),
  };
  return { instances, engine, getUserMediaStore };
});

vi.mock('./registry', () => ({
  createRegistry: () => ({ resolve: () => mocks.engine }),
}));

vi.mock('../../config/runtime', () => ({
  resolveNetworkProfile: () => ({ mode: 'browser-fetch' }),
  resolveProxyConfig: () => ({ enabled: false, url: 'http://127.0.0.1:1' }),
}));

vi.mock('../proxy/store', () => ({
  getProxyRuntimeCredentials: () => ({ proxyToken: null, proxyUrl: 'http://127.0.0.1:1' }),
}));

vi.mock('../media/user-media.storage', () => ({
  getUserMediaStore: mocks.getUserMediaStore,
}));

const created: string[] = [];
const revoked: string[] = [];
let urlCounter = 0;
let originalCreate: PropertyDescriptor | undefined;
let originalRevoke: PropertyDescriptor | undefined;

interface FakeMediaStore {
  descriptors: Map<string, unknown>;
  bytes: Map<string, Blob>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  getBytes: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function makeMediaStore(): FakeMediaStore {
  const descriptors = new Map<string, unknown>();
  const bytes = new Map<string, Blob>();
  return {
    descriptors,
    bytes,
    get: vi.fn(async (ref: string) => descriptors.get(ref) ?? null),
    list: vi.fn(async () => [...descriptors.values()]),
    put: vi.fn(async (descriptor: { ref: string }, blob: Blob) => {
      descriptors.set(descriptor.ref, descriptor);
      bytes.set(descriptor.ref, blob);
    }),
    getBytes: vi.fn(async (ref: string) => bytes.get(ref) ?? null),
    remove: vi.fn(async (ref: string) => {
      descriptors.delete(ref);
      bytes.delete(ref);
    }),
  };
}

function seedMedia(store: FakeMediaStore, ref: string, size = 4096): void {
  store.descriptors.set(ref, {
    ref,
    displayName: ref,
    fileName: `${ref}.img`,
    format: 'raw',
    size,
    integrity: 'unverified',
    importedAt: 0,
  });
  store.bytes.set(ref, new Blob([new Uint8Array(size)]));
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function loadSessionsStore() {
  vi.resetModules();
  const module = await import('./sessions.store');
  return module.useSessionsStore;
}

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  urlCounter = 0;
  mocks.instances.length = 0;
  mocks.engine.start.mockClear();
  mocks.getUserMediaStore.mockReset();

  originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      const url = `blob:lumiboot/${(urlCounter += 1)}`;
      created.push(url);
      return url;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
});

afterEach(() => {
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe('useSessionsStore — media ownership', () => {
  it('two VMs of the same OS: releasing A never revokes B media', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    const mediaStore = makeMediaStore();
    seedMedia(mediaStore, system.id);
    mocks.getUserMediaStore.mockResolvedValue(mediaStore);

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const a = useSessionsStore.getState().create(system.id);
    const b = useSessionsStore.getState().create(system.id);

    await useSessionsStore.getState().boot(a, mount);
    await useSessionsStore.getState().boot(b, mount);

    // Two VMs of the same OS get two distinct URLs, one per session.
    expect(created).toHaveLength(2);
    const [urlA, urlB] = created;
    expect(urlA).not.toBe(urlB);
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0]!.config?.media?.url).toBe(urlA);
    expect(mocks.instances[1]!.config?.media?.url).toBe(urlB);

    await useSessionsStore.getState().dispose(a);

    // Only the A URL is revoked.
    expect(revoked).toEqual([urlA]);
    expect(revoked).not.toContain(urlB);
    expect(useSessionsStore.getState().sessions[a]).toBeUndefined();
    expect(useSessionsStore.getState().sessions[b]).toBeDefined();
    expect(mocks.instances[1]!.stop).not.toHaveBeenCalled();
    expect(mocks.instances[1]!.dispose).not.toHaveBeenCalled();
  });

  it('dispose during the blob read: no start, no leak', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    const mediaStore = makeMediaStore();
    seedMedia(mediaStore, system.id);
    let resolveBytes: ((value: Blob | null) => void) | undefined;
    mediaStore.getBytes.mockImplementation(
      () =>
        new Promise<Blob | null>((resolve) => {
          resolveBytes = resolve;
        }),
    );
    mocks.getUserMediaStore.mockResolvedValue(mediaStore);

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);
    const bootPromise = useSessionsStore.getState().boot(sessionId, mount);

    await flushMicrotasks();
    expect(mediaStore.getBytes).toHaveBeenCalled();

    await useSessionsStore.getState().dispose(sessionId);
    resolveBytes?.(mediaStore.bytes.get(system.id) ?? null);
    await bootPromise;

    // Any URL created here was revoked and no VM started.
    expect(revoked).toEqual(created);
    expect(mocks.instances).toHaveLength(0);
    expect(useSessionsStore.getState().sessions[sessionId]).toBeUndefined();
  });

  it('stop during the blob read: no start, no leak', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    const mediaStore = makeMediaStore();
    seedMedia(mediaStore, system.id);
    let resolveBytes: ((value: Blob | null) => void) | undefined;
    mediaStore.getBytes.mockImplementation(
      () =>
        new Promise<Blob | null>((resolve) => {
          resolveBytes = resolve;
        }),
    );
    mocks.getUserMediaStore.mockResolvedValue(mediaStore);

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);
    const bootPromise = useSessionsStore.getState().boot(sessionId, mount);

    await flushMicrotasks();
    await useSessionsStore.getState().stop(sessionId);
    resolveBytes?.(mediaStore.bytes.get(system.id) ?? null);
    await bootPromise;

    expect(revoked).toEqual(created);
    expect(mocks.instances).toHaveLength(0);
  });

  it('dispose is idempotent: a single revocation per session', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    const mediaStore = makeMediaStore();
    seedMedia(mediaStore, system.id);
    mocks.getUserMediaStore.mockResolvedValue(mediaStore);

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);
    await useSessionsStore.getState().boot(sessionId, mount);
    expect(created).toHaveLength(1);

    await useSessionsStore.getState().dispose(sessionId);
    await useSessionsStore.getState().dispose(sessionId);

    expect(revoked).toEqual([created[0]]);
  });

  it('restarting the same session replaces its URL (no accumulation)', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    const mediaStore = makeMediaStore();
    seedMedia(mediaStore, system.id);
    mocks.getUserMediaStore.mockResolvedValue(mediaStore);

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);
    await useSessionsStore.getState().boot(sessionId, mount);
    const firstUrl = created[0];

    await useSessionsStore.getState().boot(sessionId, mount);
    const secondUrl = created[1];

    expect(secondUrl).not.toBe(firstUrl);
    // The previous URL of this session is revoked on republish.
    expect(revoked).toContain(firstUrl);
    expect(revoked).not.toContain(secondUrl);
  });
});

describe('useSessionsStore — normalized errors', () => {
  it('an IndexedDB error before lifecycle.start becomes a session status', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    mocks.getUserMediaStore.mockResolvedValue({
      get: vi.fn(async () => {
        throw new Error('IndexedDB unavailable');
      }),
    });

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);

    // The boot never rejects: the failure becomes an `error` snapshot.
    await expect(useSessionsStore.getState().boot(sessionId, mount)).resolves.toBeUndefined();
    const snapshot = useSessionsStore.getState().sessions[sessionId];
    expect(snapshot?.state).toBe('error');
    expect(snapshot?.error?.message).toContain('IndexedDB unavailable');
    expect(mocks.instances).toHaveLength(0);
  });

  it('a late failure of a superseded boot does not overwrite the current state', async () => {
    const system = getSystemById('custom-image');
    if (!system) throw new Error('test system not found');
    let rejectGet: ((error: Error) => void) | undefined;
    mocks.getUserMediaStore.mockResolvedValue({
      get: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectGet = reject;
          }),
      ),
    });

    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);
    const bootPromise = useSessionsStore.getState().boot(sessionId, mount);
    await flushMicrotasks();

    // The session is destroyed before the failure: the late error is ignored.
    await useSessionsStore.getState().dispose(sessionId);
    rejectGet?.(new Error('late IndexedDB'));
    await bootPromise;

    expect(useSessionsStore.getState().sessions[sessionId]).toBeUndefined();
  });

  it('a bundled system starts without ever querying the media storage', async () => {
    const system = getSystemById('debian-12-i386');
    if (!system) throw new Error('test system not found');
    const useSessionsStore = await loadSessionsStore();
    const mount = document.createElement('div');
    const sessionId = useSessionsStore.getState().create(system.id);

    await useSessionsStore.getState().boot(sessionId, mount);

    expect(mocks.getUserMediaStore).not.toHaveBeenCalled();
    expect(mocks.instances).toHaveLength(1);
  });
});
