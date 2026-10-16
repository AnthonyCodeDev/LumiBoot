import { describe, expect, it } from 'vitest';
import type { Architecture, OSDefinition } from '@lumiboot/contracts';
import {
  checkEngineCompatibility,
  detectRuntimeEnvironment,
  type RuntimeEnvironment,
} from './EngineCompatibility';
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

function makeEngine(id: string, architectures: readonly Architecture[]): VMEngine {
  return {
    id,
    capabilities: (): VMCapabilities => ({ ...NO_CAPABILITIES, architectures }),
    canRun: () => true,
    async start(): Promise<VMInstance> {
      throw new Error('non démarré dans ce test');
    },
  };
}

const READY_ENV: RuntimeEnvironment = { webAssembly: true, crossOriginIsolated: true };

describe('checkEngineCompatibility', () => {
  it('accepte i386 sur un moteur qui déclare i386', () => {
    const result = checkEngineCompatibility(makeEngine('v86', ['i386']), makeOS(), READY_ENV);
    expect(result).toEqual({ compatible: true, reasons: [] });
  });

  it('rejette x86_64 et arm64 avec une raison précise utilisable par l’UI', () => {
    const v86 = makeEngine('v86', ['i386']);
    const x64 = checkEngineCompatibility(v86, makeOS({ architecture: 'x86_64' }), READY_ENV);
    expect(x64.compatible).toBe(false);
    expect(x64.reasons.join(' ')).toContain('Architecture x86_64');
    expect(x64.reasons.join(' ')).toContain('v86');
    expect(x64.reasons.join(' ')).toContain('i386');

    const arm = checkEngineCompatibility(v86, makeOS({ architecture: 'arm64' }), READY_ENV);
    expect(arm.compatible).toBe(false);
    expect(arm.reasons.join(' ')).toContain('Architecture arm64');
  });

  it('refuse un environnement sans WebAssembly', () => {
    const result = checkEngineCompatibility(makeEngine('v86', ['i386']), makeOS(), {
      webAssembly: false,
      crossOriginIsolated: false,
    });
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(' ')).toContain('WebAssembly');
  });

  it('ne contredit pas un moteur qui ne déclare aucune architecture', () => {
    const result = checkEngineCompatibility(
      makeEngine('stub', []),
      makeOS({ architecture: 'arm64' }),
      READY_ENV,
    );
    expect(result.compatible).toBe(true);
  });
});

describe('detectRuntimeEnvironment', () => {
  it('lit WebAssembly et l’isolation d’origine depuis le scope fourni', () => {
    const scope = {
      WebAssembly: { instantiate: () => undefined },
      crossOriginIsolated: true,
    } as unknown as typeof globalThis;

    expect(detectRuntimeEnvironment(scope)).toEqual({
      webAssembly: true,
      crossOriginIsolated: true,
    });
  });

  it('signale l’absence de WebAssembly', () => {
    const scope = {
      crossOriginIsolated: false,
    } as unknown as typeof globalThis;

    expect(detectRuntimeEnvironment(scope)).toEqual({
      webAssembly: false,
      crossOriginIsolated: false,
    });
  });
});
