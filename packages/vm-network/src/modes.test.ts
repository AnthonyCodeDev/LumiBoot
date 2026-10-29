import { describe, expect, it } from 'vitest';
import { NETWORK_MODES, networkModes } from './modes';
import { DEFAULT_PROXY_HOST } from './proxy';

describe('NETWORK_MODES', () => {
  it('contains local-proxy between browser-fetch and user-relay', () => {
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
  it('describes the local-proxy mode', () => {
    const info = networkModes['local-proxy'];
    expect(info.id).toBe('local-proxy');
    expect(info.label).toBe('Local network proxy');
    expect(info.availability).toBe('ready');
    expect(info.requiresRestart).toBe(true);
    expect(info.requiresConfiguration).toBe(true);
    expect(info.description).toContain(DEFAULT_PROXY_HOST);
  });
});
