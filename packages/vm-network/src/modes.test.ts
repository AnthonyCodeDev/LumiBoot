import { describe, expect, it } from 'vitest';
import { NETWORK_MODES, networkModes } from './modes';

describe('NETWORK_MODES', () => {
  it('contient local-companion entre browser-fetch et user-relay', () => {
    expect(NETWORK_MODES).toEqual([
      'offline',
      'browser-fetch',
      'local-companion',
      'user-relay',
      'local-network',
    ]);
  });
});

describe('networkModes', () => {
  it('décrit le mode local-companion', () => {
    const info = networkModes['local-companion'];
    expect(info.id).toBe('local-companion');
    expect(info.label).toBe('Companion réseau local');
    expect(info.availability).toBe('ready');
    expect(info.requiresRestart).toBe(true);
    expect(info.requiresConfiguration).toBe(true);
    expect(info.description).toContain('127.0.0.1');
  });
});
