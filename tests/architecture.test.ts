import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Architecture,
  EngineId,
  OSDefinition,
  SessionEvent,
} from '../packages/contracts/src/index';
import { engines, systems } from '../packages/catalog/src/index';
import {
  checkEngineCompatibility,
  NO_CAPABILITIES,
  SessionLifecycle,
  VMRegistry,
  type VMEngine,
  type VMInstance,
} from '../packages/vm-core/src/index';
import {
  buildDeclaredPackageGraph,
  buildPackageImportGraph,
  collectSourceFiles,
  collectWorkspacePackages,
  extractModuleSpecifiers,
  findCrossPackageRelativeImports,
  findCycles,
  internalPackageFromSpecifier,
  isDeepInternalSpecifier,
} from './arch/dependency-graph';

/** Vitest runs from the repository root. */
const repoRoot = process.cwd();

/** Packages that must not depend on any UI framework or on `apps/web`. */
const ISOLATED_PACKAGES = [
  'packages/vm-core',
  'packages/vm-network',
  'packages/provider-v86',
  'packages/vm-assets',
  'packages/vm-storage',
  'packages/catalog',
  'packages/contracts',
];

const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'react', pattern: /from\s+['"]react(?:-dom)?(?:['"/])/ },
  { name: 'zustand', pattern: /from\s+['"]zustand/ },
  { name: 'apps/web', pattern: /from\s+['"][^'"]*apps\/web/ },
  { name: '@lumiboot/web', pattern: /@lumiboot\/web/ },
];

const VM_CORE_FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'HTMLElement', pattern: /\bHTMLElement\b/ },
  { name: 'document', pattern: /\bdocument\b/ },
  { name: 'window', pattern: /\bwindow\b/ },
  { name: 'localStorage', pattern: /\blocalStorage\b/ },
  { name: 'indexedDB', pattern: /\bindexedDB\b/ },
];

const workspacePackages = collectWorkspacePackages(repoRoot);
const packageByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg] as const));

/**
 * ALLOWED internal dependencies, per package. Any edge missing from this table is
 * forbidden: adding a cross-package dependency requires an explicit decision
 * (and updates this table + `docs/ARCHITECTURE.md`).
 *
 * Direction rules:
 * - `contracts` is a leaf (no `@lumiboot/*`);
 * - `catalog` only depends on the shared types;
 * - `vm-core` orchestrates (`vm-network` for the network profile) without
 *   knowing the providers;
 * - `provider-v86` depends on the orchestrator and the assets, never on the
 *   catalog;
 * - `apps/web` assembles, never the other way around.
 */
const ALLOWED_INTERNAL_DEPS: Record<string, readonly string[]> = {
  '@lumiboot/contracts': [],
  '@lumiboot/catalog': ['@lumiboot/contracts'],
  '@lumiboot/vm-network': ['@lumiboot/contracts'],
  '@lumiboot/vm-storage': [],
  '@lumiboot/vm-assets': ['@lumiboot/contracts'],
  '@lumiboot/vm-core': ['@lumiboot/contracts', '@lumiboot/vm-network'],
  '@lumiboot/provider-v86': [
    '@lumiboot/contracts',
    '@lumiboot/vm-assets',
    '@lumiboot/vm-core',
    '@lumiboot/vm-network',
  ],
  '@lumiboot/web': [
    '@lumiboot/catalog',
    '@lumiboot/contracts',
    '@lumiboot/provider-v86',
    '@lumiboot/vm-assets',
    '@lumiboot/vm-core',
    '@lumiboot/vm-network',
  ],
};

/**
 * Architectures actually served by each catalog engine. This is the
 * `architecture x engineId` compatibility contract: a profile that pairs an
 * i386 system with an x86-64 engine breaks the runtime invariant.
 */
const ENGINE_ARCHITECTURES: Record<EngineId, readonly Architecture[]> = {
  v86: ['i386', 'x86'],
  'wasm-x86': ['i386', 'x86'],
  'wasm-x86_64': ['x86_64'],
  'wasm-arm': ['arm', 'arm64'],
  'wasm-powerpc': ['powerpc'],
  'wasm-68k': ['m68k'],
};

function collectPackageSourceFiles(relDir: string): string[] {
  return collectSourceFiles(join(repoRoot, relDir, 'src'));
}

describe('architectural isolation', () => {
  for (const pkg of ISOLATED_PACKAGES) {
    it(`${pkg} imports neither React, nor Zustand, nor the front-end`, () => {
      const files = collectSourceFiles(join(repoRoot, pkg, 'src'));
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(content)) violations.push(`${file} imports ${rule.name}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('packages/vm-core stays independent from the DOM', () => {
    const files = collectSourceFiles(join(repoRoot, 'packages/vm-core', 'src')).filter(
      (file) => !file.endsWith('.test.ts'),
    );
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const rule of VM_CORE_FORBIDDEN) {
        if (rule.pattern.test(content)) violations.push(`${file} uses ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('package boundaries', () => {
  it('every workspace package declares its boundaries', () => {
    const undeclared = workspacePackages
      .map((pkg) => pkg.name)
      .filter((name) => ALLOWED_INTERNAL_DEPS[name] === undefined);
    expect(undeclared).toEqual([]);
  });

  it('no package depends on a non-existent internal package', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      for (const dep of pkg.internalDeps) {
        if (!packageByName.has(dep)) {
          violations.push(`${pkg.name} declares "${dep}", missing from the workspace`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('every internal dependency declaration stays inside the allowed boundary', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      const allowed = ALLOWED_INTERNAL_DEPS[pkg.name] ?? [];
      for (const dep of pkg.internalDeps) {
        if (!allowed.includes(dep)) {
          violations.push(`${pkg.name} -> ${dep}: forbidden dependency`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('actual imports stay inside the declared dependencies (no phantom dependency)', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      const declared = new Set(pkg.internalDeps);
      const allowed = ALLOWED_INTERNAL_DEPS[pkg.name] ?? [];
      for (const file of collectPackageSourceFiles(pkg.relDir)) {
        const source = readFileSync(file, 'utf8');
        for (const specifier of extractModuleSpecifiers(source)) {
          const target = internalPackageFromSpecifier(specifier);
          if (target === null) continue;
          if (target === pkg.name) {
            violations.push(`${pkg.relDir}: ${file} imports itself via "${target}"`);
          } else if (!declared.has(target)) {
            violations.push(`${pkg.relDir}: ${file} imports undeclared "${target}"`);
          } else if (!allowed.includes(target)) {
            violations.push(`${pkg.relDir}: ${file} imports "${target}" outside its boundary`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('contracts is a leaf without any internal dependency', () => {
    const contracts = packageByName.get('@lumiboot/contracts');
    expect(contracts?.internalDeps).toEqual([]);
    const graph = buildPackageImportGraph(workspacePackages);
    expect([...(graph.get('@lumiboot/contracts') ?? [])]).toEqual([]);
  });

  it('no deep `@lumiboot/<pkg>/...` import bypasses the public surface', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      for (const file of collectPackageSourceFiles(pkg.relDir)) {
        const source = readFileSync(file, 'utf8');
        for (const specifier of extractModuleSpecifiers(source)) {
          if (isDeepInternalSpecifier(specifier)) {
            violations.push(`${pkg.relDir}: ${file} imports "${specifier}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no relative import crosses another package', () => {
    expect(findCrossPackageRelativeImports(workspacePackages)).toEqual([]);
  });
});

describe('dependency cycles', () => {
  it('the declared graph is acyclic', () => {
    expect(findCycles(buildDeclaredPackageGraph(workspacePackages))).toEqual([]);
  });

  it('the actual import graph is acyclic', () => {
    expect(findCycles(buildPackageImportGraph(workspacePackages))).toEqual([]);
  });

  it('the tool really sees the edges and the sources (non-vacuity)', () => {
    expect(collectPackageSourceFiles('packages/vm-core').length).toBeGreaterThan(0);
    const graph = buildPackageImportGraph(workspacePackages);
    expect([...(graph.get('@lumiboot/provider-v86') ?? [])]).toContain('@lumiboot/vm-core');
    expect([...(graph.get('@lumiboot/catalog') ?? [])]).toContain('@lumiboot/contracts');
    expect([...(graph.get('@lumiboot/contracts') ?? [])]).toEqual([]);
  });

  it('the cycle detector really detects a cycle', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set()],
    ]);
    expect(findCycles(graph)).toEqual([['a', 'b', 'c']]);
  });
});

describe('runtime profile / engineId compatibility', () => {
  it('every profile references a catalog engine that exists', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        if (engines[profile.engineId] === undefined) {
          violations.push(`${system.id}/${profile.id}: unknown engine "${profile.engineId}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the architecture table covers exactly the catalog engines', () => {
    expect(Object.keys(engines).sort()).toEqual(Object.keys(ENGINE_ARCHITECTURES).sort());
  });

  it('the system architecture is supported by the engine of every profile', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const supported = ENGINE_ARCHITECTURES[profile.engineId];
        if (supported !== undefined && !supported.includes(system.architecture)) {
          violations.push(
            `${system.id}/${profile.id}: architecture ${system.architecture} not served by ${profile.engineId}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('no validated profile relies on a non-integrated engine', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const engine = engines[profile.engineId];
        if (!engine) continue;
        if (!engine.integrated && system.availability === 'ready') {
          violations.push(
            `${system.id}/${profile.id}: engine "${profile.engineId}" not integrated`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('checkEngineCompatibility accepts every integrated profile with WebAssembly', () => {
    const env = { webAssembly: true, crossOriginIsolated: true };
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const definition = engines[profile.engineId];
        if (!definition?.integrated) continue;
        const result = checkEngineCompatibility(makeStubEngine(profile.engineId), system, env);
        if (!result.compatible) {
          violations.push(`${system.id}/${profile.id}: ${result.reasons.join(' ')}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('checkEngineCompatibility rejects an environment without WebAssembly', () => {
    const system = systems.find((candidate) =>
      candidate.launchProfiles.some(
        (profile) => profile.engineId === 'v86' && profile.executionMode === 'browser',
      ),
    );
    expect(system).toBeDefined();
    const result = checkEngineCompatibility(makeStubEngine('v86'), system!, {
      webAssembly: false,
      crossOriginIsolated: false,
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('WebAssembly');
  });
});

describe('session concurrency and isolation', () => {
  it('two concurrent start() calls create a single instance', async () => {
    const fake = createFakeEngine();
    const lifecycle = new SessionLifecycle(
      systems[0]!,
      new VMRegistry([fake.engine]),
      'concurrent-start',
    );

    await Promise.all([lifecycle.start({}), lifecycle.start({})]);

    expect(fake.starts()).toBe(1);
    expect(fake.instances).toHaveLength(1);
    await lifecycle.dispose();
  });

  it('two concurrent sessions stay isolated', async () => {
    const first = createFakeEngine('engine-a');
    const second = createFakeEngine('engine-b');
    const lifecycleA = new SessionLifecycle(
      systems[0]!,
      new VMRegistry([first.engine]),
      'session-a',
    );
    const lifecycleB = new SessionLifecycle(
      systems[0]!,
      new VMRegistry([second.engine]),
      'session-b',
    );

    await Promise.all([lifecycleA.start({}), lifecycleB.start({})]);

    expect(first.starts()).toBe(1);
    expect(second.starts()).toBe(1);
    expect(lifecycleA.snapshot.providerId).toBe('engine-a');
    expect(lifecycleB.snapshot.providerId).toBe('engine-b');
    expect(lifecycleA.snapshot.id).not.toBe(lifecycleB.snapshot.id);

    await Promise.all([lifecycleA.dispose(), lifecycleB.dispose()]);
  });

  it('dispose() during an in-flight start releases the instance without orphans', async () => {
    const deferred = createDeferredEngine();
    const lifecycle = new SessionLifecycle(
      systems[0]!,
      new VMRegistry([deferred.engine]),
      'dispose-during-start',
    );

    const startPromise = lifecycle.start({});
    const disposePromise = lifecycle.dispose();
    deferred.release();
    await Promise.all([startPromise, disposePromise]);

    expect(deferred.disposed()).toBeGreaterThanOrEqual(1);
    expect(lifecycle.disposed).toBe(true);
  });

  it('register() is idempotent for the same engine', () => {
    const registry = new VMRegistry([]);
    const engine = createFakeEngine().engine;
    registry.register(engine);
    registry.register(engine);
    expect(registry.engines).toHaveLength(1);
  });
});

/** Minimal fake engine for the lifecycle concurrency tests. */
function createFakeEngine(id = 'fake-engine'): {
  engine: VMEngine;
  starts: () => number;
  instances: VMInstance[];
} {
  let starts = 0;
  const instances: VMInstance[] = [];
  const engine: VMEngine = {
    id,
    capabilities: () => NO_CAPABILITIES,
    canRun: () => true,
    start: async (os: OSDefinition): Promise<VMInstance> => {
      starts += 1;
      const listeners = new Set<(event: SessionEvent) => void>();
      const instance: VMInstance = {
        id: `${id}-instance-${starts}`,
        providerId: id,
        systemId: os.id,
        async stop(): Promise<void> {
          /* no-op */
        },
        async dispose(): Promise<void> {
          listeners.clear();
        },
        subscribe(listener): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      instances.push(instance);
      return instance;
    },
  };
  return { engine, starts: () => starts, instances };
}

/** Engine whose `start()` stays in flight until `release()`. */
function createDeferredEngine(): {
  engine: VMEngine;
  release: () => void;
  disposed: () => number;
} {
  let resolveStart: (instance: VMInstance) => void = () => undefined;
  let disposed = 0;
  let created: VMInstance | undefined;
  const engine: VMEngine = {
    id: 'deferred-engine',
    capabilities: () => NO_CAPABILITIES,
    canRun: () => true,
    start: (os: OSDefinition): Promise<VMInstance> => {
      created = {
        id: 'deferred-instance',
        providerId: 'deferred-engine',
        systemId: os.id,
        async stop(): Promise<void> {
          /* no-op */
        },
        async dispose(): Promise<void> {
          disposed += 1;
        },
        subscribe(): () => void {
          return () => undefined;
        },
      };
      return new Promise<VMInstance>((resolve) => {
        resolveStart = resolve;
      });
    },
  };
  return {
    engine,
    release: () => {
      if (created !== undefined) resolveStart(created);
    },
    disposed: () => disposed,
  };
}

/** Fake engine mirroring the catalog capabilities and `canRun`. */
function makeStubEngine(engineId: EngineId): VMEngine {
  return {
    id: engineId,
    capabilities: () => ({
      runtime: 'browser',
      architectures: [...ENGINE_ARCHITECTURES[engineId]],
      ramSnapshots: false,
      diskSnapshots: false,
      partialDownload: false,
      resumable: false,
      configurableMemory: true,
    }),
    canRun: (os: OSDefinition): boolean =>
      os.launchProfiles.some(
        (profile) => profile.engineId === engineId && profile.executionMode === 'browser',
      ),
    start: async (os: OSDefinition): Promise<VMInstance> => {
      throw new Error(`Fake engine: start not supported for ${os.id}.`);
    },
  };
}
