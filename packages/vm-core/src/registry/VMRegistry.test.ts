import { describe, expect, it } from 'vitest';
import type { Architecture, OSDefinition, SessionEvent } from '@lumiboot/contracts';
import { VMRegistry } from './VMRegistry';
import { NO_CAPABILITIES, type VMCapabilities } from '../contracts/VMCapabilities';
import type { VMEngine } from '../contracts/VMEngine';
import type { VMInstance } from '../contracts/VMInstance';

function makeOS(overrides: Partial<OSDefinition> = {}): OSDefinition {
  return {
    id: 'test-os',
    slug: 'test-os',
    family: 'linux',
    displayName: 'Test',
    versionLabel: '1.0',
    architecture: 'i386',
    availability: 'planned',
    description: 'desc',
    iconUrl: '/icons/os/test.svg',
    imageRef: 'test-image',
    launchProfiles: [
      {
        id: 'default',
        engineId: 'v86',
        executionMode: 'browser',
        minMemoryMiB: 128,
      },
    ],
    requirements: ['WebAssembly'],
    accent: '#000000',
    accentRgb: '0,0,0',
    integrationNote: 'note',
    ...overrides,
  };
}

class RecordingEngine implements VMEngine {
  readonly id = 'recording';
  capabilities(): VMCapabilities {
    return NO_CAPABILITIES;
  }
  canRun(): boolean {
    return true;
  }
  async start(): Promise<VMInstance> {
    return {
      id: 'h1',
      providerId: this.id,
      systemId: 'test-os',
      async stop() {},
      async dispose() {},
      subscribe() {
        return () => {};
      },
    };
  }
}

describe('VMRegistry', () => {
  it('utilise le repli honnête sans moteur correspondant', () => {
    const registry = new VMRegistry();
    expect(registry.resolve(makeOS()).id).toBe('unavailable');
  });

  it('sélectionne le premier moteur dont canRun est vrai', () => {
    const registry = new VMRegistry([new RecordingEngine()]);
    expect(registry.resolve(makeOS()).id).toBe('recording');
  });

  it('le repli signale le moteur non intégré au premier abonné', async () => {
    const registry = new VMRegistry();
    const instance = await registry.start(makeOS(), document.createElement('div'));
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));
    expect(events[0]).toMatchObject({ type: 'error', code: 'ENGINE_NOT_INTEGRATED' });
  });

  it('ignore un moteur déjà enregistré', () => {
    const registry = new VMRegistry([new RecordingEngine()]);
    registry.register(new RecordingEngine());
    expect(registry.engines).toHaveLength(1);
  });
});

/** Moteur dont on choisit les capacités d'architecture et `canRun`. */
function makeEngine(options: {
  id: string;
  architectures?: readonly Architecture[];
  canRun?: (os: OSDefinition) => boolean;
}): VMEngine {
  return {
    id: options.id,
    capabilities: (): VMCapabilities => ({
      ...NO_CAPABILITIES,
      architectures: options.architectures ?? [],
    }),
    canRun: options.canRun ?? (() => true),
    async start(os: OSDefinition): Promise<VMInstance> {
      return {
        id: `${options.id}-instance`,
        providerId: options.id,
        systemId: os.id,
        async stop() {},
        async dispose() {},
        subscribe() {
          return () => {};
        },
      };
    },
  };
}

describe('VMRegistry — compatibilité architecture/CPU et navigateur', () => {
  const ENV = { webAssembly: true, crossOriginIsolated: true };

  it('accepte v86 pour i386 et rejette x86_64/arm64 sans preuve de support', () => {
    const v86 = makeEngine({ id: 'v86', architectures: ['i386'] });
    const registry = new VMRegistry([v86], undefined, ENV);

    expect(registry.resolve(makeOS()).id).toBe('v86');
    expect(registry.resolve(makeOS({ architecture: 'x86_64' })).id).toBe('unavailable');
    expect(registry.resolve(makeOS({ architecture: 'arm64' })).id).toBe('unavailable');

    const result = registry.explain(makeOS({ architecture: 'x86_64' }));
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('Architecture x86_64');
    expect(result.reasons.join(' ')).toContain('i386');
  });

  it('accepte un moteur qui déclare réellement l’architecture demandée', () => {
    const engine = makeEngine({ id: 'arm-engine', architectures: ['arm64'] });
    const registry = new VMRegistry([engine], undefined, ENV);

    expect(registry.resolve(makeOS({ architecture: 'arm64' })).id).toBe('arm-engine');
    expect(registry.resolve(makeOS({ architecture: 'i386' })).id).toBe('unavailable');
  });

  it('impose le prérequis navigateur WebAssembly', () => {
    const engine = makeEngine({ id: 'v86', architectures: ['i386'] });
    const registry = new VMRegistry([engine], undefined, {
      webAssembly: false,
      crossOriginIsolated: false,
    });

    expect(registry.resolve(makeOS()).id).toBe('unavailable');
    const result = registry.explain(makeOS());
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('WebAssembly');
  });

  it('ne contredit pas un moteur qui ne déclare aucune architecture', () => {
    const registry = new VMRegistry([new RecordingEngine()], undefined, ENV);
    expect(registry.resolve(makeOS({ architecture: 'arm64' })).id).toBe('recording');
  });

  it('start() respecte la compatibilité : aucun lancement incompatible', async () => {
    const engine = makeEngine({ id: 'v86', architectures: ['i386'] });
    const registry = new VMRegistry([engine], undefined, ENV);

    const instance = await registry.start(
      makeOS({ architecture: 'x86_64' }),
      document.createElement('div'),
    );
    const events: SessionEvent[] = [];
    instance.subscribe((event) => events.push(event));

    expect(events[0]).toMatchObject({ type: 'error', code: 'ENGINE_NOT_INTEGRATED' });
  });
});
