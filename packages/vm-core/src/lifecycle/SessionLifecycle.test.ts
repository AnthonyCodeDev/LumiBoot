import { describe, expect, it, vi } from 'vitest';
import type { OSDefinition } from '@lumiboot/contracts';
import { SessionLifecycle } from './SessionLifecycle';
import { VMRegistry } from '../registry/VMRegistry';

function makeOS(overrides: Partial<OSDefinition> = {}): OSDefinition {
  return {
    id: 'debian-12-i386',
    slug: 'debian-12-i386',
    family: 'linux',
    displayName: 'Debian',
    versionLabel: '12 Bookworm',
    architecture: 'i386',
    executionMode: 'browser',
    engineId: 'v86',
    availability: 'planned',
    description: 'desc',
    iconUrl: '/icons/os/debian.svg',
    requirements: ['WebAssembly'],
    accent: '#ec4264',
    accentRgb: '236,66,100',
    integrationNote: 'note',
    ...overrides,
  };
}

describe('SessionLifecycle', () => {
  it('se termine en erreur honnête quand aucun moteur n’est intégré', async () => {
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry(), 's1');
    const listener = vi.fn();
    lifecycle.subscribe(listener);

    await lifecycle.start(document.createElement('div'));

    expect(lifecycle.snapshot.state).toBe('error');
    expect(lifecycle.snapshot.error?.code).toBe('ENGINE_NOT_INTEGRATED');
    expect(listener).toHaveBeenCalled();
  });

  it('ne démarre pas deux fois la même session', async () => {
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry(), 's2');
    const mount = document.createElement('div');
    await lifecycle.start(mount);
    await lifecycle.start(mount);
    expect(lifecycle.snapshot.state).toBe('error');
  });

  it('ne fait rien à l’arrêt dans un état terminal', async () => {
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry(), 's3');
    await lifecycle.start(document.createElement('div'));
    await lifecycle.stop();
    expect(lifecycle.snapshot.state).toBe('error');
  });

  it('libère les ressources au dispose', async () => {
    const lifecycle = new SessionLifecycle(makeOS(), new VMRegistry(), 's4');
    await lifecycle.start(document.createElement('div'));
    await lifecycle.dispose();
    expect(lifecycle.snapshot.providerId).toBe('unavailable');
  });
});
