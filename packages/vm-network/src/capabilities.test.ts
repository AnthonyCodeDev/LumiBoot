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
  it('offline : tous les niveaux désactivés, transport none', () => {
    expect(Object.values(OFFLINE_CAPABILITIES.nic).every((value) => value === false)).toBe(true);
    expect(Object.values(OFFLINE_CAPABILITIES.guestStack).every((value) => value === false)).toBe(
      true,
    );
    expect(OFFLINE_CAPABILITIES.transport.kind).toBe('none');
    expect(OFFLINE_CAPABILITIES.transport.http).toBe(false);
    expect(OFFLINE_CAPABILITIES.fullInternet).toBe(false);
  });

  it('browser-fetch : HTTP(S) via fetch soumis à CORS, udp/icmp false, fullInternet false', () => {
    expect(BROWSER_FETCH_CAPABILITIES.transport.kind).toBe('fetch');
    expect(BROWSER_FETCH_CAPABILITIES.transport.http).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.transport.https).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.transport.cors).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.dhcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.dns).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.tcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.udp).toBe(false);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.icmp).toBe(false);
    expect(BROWSER_FETCH_CAPABILITIES.fullInternet).toBe(false);
  });

  it('user-relay : ne garantit pas fullInternet, cors false, udp/icmp false par défaut', () => {
    expect(USER_RELAY_CAPABILITIES.transport.kind).toBe('wisp');
    expect(USER_RELAY_CAPABILITIES.transport.cors).toBe(false);
    expect(USER_RELAY_CAPABILITIES.guestStack.udp).toBe(false);
    expect(USER_RELAY_CAPABILITIES.guestStack.icmp).toBe(false);
    expect(USER_RELAY_CAPABILITIES.fullInternet).toBe(false);
  });

  it('local-network : indisponible tant que non implémenté', () => {
    expect(Object.values(LOCAL_NETWORK_CAPABILITIES.nic).every((value) => value === false)).toBe(
      true,
    );
    expect(LOCAL_NETWORK_CAPABILITIES.transport.kind).toBe('none');
    expect(LOCAL_NETWORK_CAPABILITIES.fullInternet).toBe(false);
  });

  it('aucun mode ne promet Internet complet sans vérification à l’exécution', () => {
    for (const mode of NETWORK_MODES) {
      expect(capabilitiesForMode(mode).fullInternet).toBe(false);
    }
  });

  it('sépare bien NIC, pile invitée et transport', () => {
    expect(BROWSER_FETCH_CAPABILITIES.nic.ethernet).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.ip).toBe(true);
    expect(typeof BROWSER_FETCH_CAPABILITIES.transport.kind).toBe('string');
  });

  it('retourne le jeu de capacités du mode', () => {
    expect(capabilitiesForMode('offline')).toBe(OFFLINE_CAPABILITIES);
    expect(capabilitiesForMode('browser-fetch')).toBe(BROWSER_FETCH_CAPABILITIES);
    expect(capabilitiesForMode('user-relay')).toBe(USER_RELAY_CAPABILITIES);
    expect(capabilitiesForMode('local-network')).toBe(LOCAL_NETWORK_CAPABILITIES);
  });

  it('couvre tous les modes déclarés', () => {
    for (const mode of NETWORK_MODES) {
      const capabilities = capabilitiesForMode(mode);
      expect(Object.values(capabilities.nic).length).toBeGreaterThan(0);
      expect(Object.values(capabilities.guestStack).length).toBeGreaterThan(0);
      expect(Object.values(capabilities.transport).length).toBeGreaterThan(0);
    }
  });
});
