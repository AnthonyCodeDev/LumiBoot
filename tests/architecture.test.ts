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

/** Vitest s'exécute depuis la racine du dépôt. */
const repoRoot = process.cwd();

/** Packages qui ne doivent dépendre d'aucun framework d'UI ni de `apps/web`. */
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
 * Dépendances internes AUTORISÉES, par paquet. Toute arête absente de cette
 * table est interdite : ajouter une dépendance inter-paquets exige une décision
 * explicite (et met à jour cette table + `docs/ARCHITECTURE.md`).
 *
 * Règles de sens :
 * - `contracts` est une feuille (aucun `@lumiboot/*`) ;
 * - `catalog` ne dépend que des types partagés ;
 * - `vm-core` orchestre (`vm-network` pour le profil réseau) sans connaître les
 *   providers ;
 * - `provider-v86` dépend de l'orchestrateur et des assets, jamais du catalogue ;
 * - `apps/web` assemble, jamais l'inverse.
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
 * Architectures réellement servies par chaque moteur du catalogue. Sert de
 * contrat de compatibilité `architecture × engineId` : un profil qui associe un
 * système i386 à un moteur x86-64 casse l'invariant runtime.
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

describe('isolation architecturale', () => {
  for (const pkg of ISOLATED_PACKAGES) {
    it(`${pkg} n'importe ni React, ni Zustand, ni le front-end`, () => {
      const files = collectSourceFiles(join(repoRoot, pkg, 'src'));
      const violations: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(content)) violations.push(`${file} importe ${rule.name}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it('packages/vm-core reste indépendant du DOM', () => {
    const files = collectSourceFiles(join(repoRoot, 'packages/vm-core', 'src')).filter(
      (file) => !file.endsWith('.test.ts'),
    );
    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const rule of VM_CORE_FORBIDDEN) {
        if (rule.pattern.test(content)) violations.push(`${file} utilise ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('frontières de paquets', () => {
  it('chaque paquet de l’espace de travail déclare ses frontières', () => {
    const undeclared = workspacePackages
      .map((pkg) => pkg.name)
      .filter((name) => ALLOWED_INTERNAL_DEPS[name] === undefined);
    expect(undeclared).toEqual([]);
  });

  it('aucun paquet ne dépend d’un paquet interne inexistant', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      for (const dep of pkg.internalDeps) {
        if (!packageByName.has(dep)) {
          violations.push(`${pkg.name} déclare « ${dep} », absent de l’espace de travail`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('chaque déclaration de dépendance interne reste dans la frontière autorisée', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      const allowed = ALLOWED_INTERNAL_DEPS[pkg.name] ?? [];
      for (const dep of pkg.internalDeps) {
        if (!allowed.includes(dep)) {
          violations.push(`${pkg.name} → ${dep} : dépendance interdite`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('les imports réels restent dans les dépendances déclarées (pas de dépendance fantôme)', () => {
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
            violations.push(`${pkg.relDir}: ${file} s’importe lui-même via « ${target} »`);
          } else if (!declared.has(target)) {
            violations.push(`${pkg.relDir}: ${file} importe « ${target} » non déclaré`);
          } else if (!allowed.includes(target)) {
            violations.push(`${pkg.relDir}: ${file} importe « ${target} » hors frontière`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('contracts est une feuille sans aucune dépendance interne', () => {
    const contracts = packageByName.get('@lumiboot/contracts');
    expect(contracts?.internalDeps).toEqual([]);
    const graph = buildPackageImportGraph(workspacePackages);
    expect([...(graph.get('@lumiboot/contracts') ?? [])]).toEqual([]);
  });

  it('aucun import profond `@lumiboot/<pkg>/…` ne contourne la surface publique', () => {
    const violations: string[] = [];
    for (const pkg of workspacePackages) {
      for (const file of collectPackageSourceFiles(pkg.relDir)) {
        const source = readFileSync(file, 'utf8');
        for (const specifier of extractModuleSpecifiers(source)) {
          if (isDeepInternalSpecifier(specifier)) {
            violations.push(`${pkg.relDir}: ${file} importe « ${specifier} »`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('aucun import relatif ne traverse un autre paquet', () => {
    expect(findCrossPackageRelativeImports(workspacePackages)).toEqual([]);
  });
});

describe('cycles de dépendances', () => {
  it('le graphe déclaré est acyclique', () => {
    expect(findCycles(buildDeclaredPackageGraph(workspacePackages))).toEqual([]);
  });

  it('le graphe d’imports réels est acyclique', () => {
    expect(findCycles(buildPackageImportGraph(workspacePackages))).toEqual([]);
  });

  it('l’outil voit réellement les arêtes et les sources (non vacuité)', () => {
    expect(collectPackageSourceFiles('packages/vm-core').length).toBeGreaterThan(0);
    const graph = buildPackageImportGraph(workspacePackages);
    expect([...(graph.get('@lumiboot/provider-v86') ?? [])]).toContain('@lumiboot/vm-core');
    expect([...(graph.get('@lumiboot/catalog') ?? [])]).toContain('@lumiboot/contracts');
    expect([...(graph.get('@lumiboot/contracts') ?? [])]).toEqual([]);
  });

  it('le détecteur de cycles détecte réellement un cycle', () => {
    const graph = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
      ['d', new Set()],
    ]);
    expect(findCycles(graph)).toEqual([['a', 'b', 'c']]);
  });
});

describe('compatibilité runtime profil / engineId', () => {
  it('chaque profil référence un moteur connu du catalogue', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        if (engines[profile.engineId] === undefined) {
          violations.push(`${system.id}/${profile.id} : moteur « ${profile.engineId} » inconnu`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('la table d’architectures couvre exactement les moteurs du catalogue', () => {
    expect(Object.keys(engines).sort()).toEqual(Object.keys(ENGINE_ARCHITECTURES).sort());
  });

  it('l’architecture du système est supportée par le moteur de chaque profil', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const supported = ENGINE_ARCHITECTURES[profile.engineId];
        if (supported !== undefined && !supported.includes(system.architecture)) {
          violations.push(
            `${system.id}/${profile.id} : architecture ${system.architecture} non servie par ${profile.engineId}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('aucun profil validé ne s’appuie sur un moteur non intégré', () => {
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const engine = engines[profile.engineId];
        if (!engine) continue;
        if (!engine.integrated && system.availability === 'ready') {
          violations.push(
            `${system.id}/${profile.id} : moteur « ${profile.engineId} » non intégré`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('checkEngineCompatibility accepte chaque profil intégré avec WebAssembly', () => {
    const env = { webAssembly: true, crossOriginIsolated: true };
    const violations: string[] = [];
    for (const system of systems) {
      for (const profile of system.launchProfiles) {
        const definition = engines[profile.engineId];
        if (!definition?.integrated) continue;
        const result = checkEngineCompatibility(makeStubEngine(profile.engineId), system, env);
        if (!result.compatible) {
          violations.push(`${system.id}/${profile.id} : ${result.reasons.join(' ')}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('checkEngineCompatibility refuse un environnement sans WebAssembly', () => {
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

describe('concurrence et isolation des sessions', () => {
  it('deux start() concurrents ne créent qu’une seule instance', async () => {
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

  it('deux sessions concurrentes restent isolées', async () => {
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

  it('dispose() pendant un start en vol libère l’instance sans orpheline', async () => {
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

  it('register() est idempotent pour un même moteur', () => {
    const registry = new VMRegistry([]);
    const engine = createFakeEngine().engine;
    registry.register(engine);
    registry.register(engine);
    expect(registry.engines).toHaveLength(1);
  });
});

/** Moteur factice minimal pour les tests de concurrence du cycle de vie. */
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

/** Moteur dont `start()` reste en vol jusqu’à `release()`. */
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

/** Moteur factice reflétant les capacités et `canRun` du catalogue. */
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
      throw new Error(`Moteur factice : démarrage non supporté pour ${os.id}.`);
    },
  };
}
