import { describe, expect, it } from 'vitest';
import {
  BROWSER_FETCH_CAPABILITIES,
  LOCAL_NETWORK_CAPABILITIES,
  OFFLINE_CAPABILITIES,
  USER_RELAY_CAPABILITIES,
  capabilitiesForMode,
} from './capabilities';
import { NETWORK_MODES } from './modes';

describe('capabilitiesForMode', () => {
  it('offline : toutes les capacités à false', () => {
    expect(Object.values(OFFLINE_CAPABILITIES).every((value) => value === false)).toBe(true);
  });

  it('browser-fetch : http/https true, cors true (contrainte), fullInternet false', () => {
    expect(BROWSER_FETCH_CAPABILITIES.http).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.https).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.dhcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.dns).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.tcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.udp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.cors).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.fullInternet).toBe(false);
  });

  it('user-relay : fullInternet true, cors false', () => {
    expect(USER_RELAY_CAPABILITIES.fullInternet).toBe(true);
    expect(USER_RELAY_CAPABILITIES.cors).toBe(false);
  });

  it('local-network : pas de fullInternet externe', () => {
    expect(LOCAL_NETWORK_CAPABILITIES.fullInternet).toBe(false);
  });

  it('retourne le jeu de capacités du mode', () => {
    expect(capabilitiesForMode('offline')).toBe(OFFLINE_CAPABILITIES);
    expect(capabilitiesForMode('browser-fetch')).toBe(BROWSER_FETCH_CAPABILITIES);
    expect(capabilitiesForMode('user-relay')).toBe(USER_RELAY_CAPABILITIES);
    expect(capabilitiesForMode('local-network')).toBe(LOCAL_NETWORK_CAPABILITIES);
  });

  it('couvre tous les modes déclarés', () => {
    for (const mode of NETWORK_MODES) {
      expect(Object.values(capabilitiesForMode(mode)).length).toBeGreaterThan(0);
    }
  });
});
