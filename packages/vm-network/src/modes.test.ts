import { describe, expect, it } from 'vitest';
import { NETWORK_MODES, networkModes } from './modes';

describe('NETWORK_MODES', () => {
  it('contient local-proxy entre browser-fetch et user-relay', () => {
    expect(NETWORK_MODES).toEqual([
      'offline',
      'browser-fetch',
      'local-proxy',
      'user-relay',
      'local-network',
    ]);
  });
});

describe('networkModes', () => {
  it('décrit le mode local-proxy', () => {
    const info = networkModes['local-proxy'];
    expect(info.id).toBe('local-proxy');
    expect(info.label).toBe('Proxy réseau local');
    expect(info.availability).toBe('ready');
    expect(info.requiresRestart).toBe(true);
    expect(info.requiresConfiguration).toBe(true);
    expect(info.description).toContain('127.0.0.1');
  });
});
