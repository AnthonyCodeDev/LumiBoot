import { describe, expect, it } from 'vitest';
import type { OSDefinition, SessionEvent } from '@lumiboot/contracts';
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
    executionMode: 'browser',
    engineId: 'v86',
    availability: 'planned',
    description: 'desc',
    iconUrl: '/icons/os/test.svg',
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
