import { describe, expect, it } from 'vitest';
import {
  BROWSER_FETCH_CAPABILITIES,
  LOCAL_PROXY_CAPABILITIES,
  LOCAL_NETWORK_CAPABILITIES,
  OFFLINE_CAPABILITIES,
  USER_RELAY_CAPABILITIES,
  capabilitiesForMode,
} from './capabilities';
import { NETWORK_MODES } from './modes';

describe('capabilitiesForMode', () => {
  it('offline: every level disabled, transport none', () => {
    expect(Object.values(OFFLINE_CAPABILITIES.nic).every((value) => value === false)).toBe(true);
    expect(Object.values(OFFLINE_CAPABILITIES.guestStack).every((value) => value === false)).toBe(
      true,
    );
    expect(OFFLINE_CAPABILITIES.transport.kind).toBe('none');
    expect(OFFLINE_CAPABILITIES.transport.http).toBe(false);
    expect(OFFLINE_CAPABILITIES.fullInternet).toBe(false);
  });

  it('browser-fetch: HTTP only (HTTPS unsupported), cors true, udp/icmp false, fullInternet false', () => {
    expect(BROWSER_FETCH_CAPABILITIES.transport.kind).toBe('fetch');
    expect(BROWSER_FETCH_CAPABILITIES.transport.http).toBe(true);
    // v86 0.5.471 only registers TCP for port 80: HTTPS (443) fails.
    expect(BROWSER_FETCH_CAPABILITIES.transport.https).toBe(false);
    expect(BROWSER_FETCH_CAPABILITIES.transport.cors).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.dhcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.dns).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.tcp).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.udp).toBe(false);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.icmp).toBe(false);
    expect(BROWSER_FETCH_CAPABILITIES.fullInternet).toBe(false);
  });

  it('user-relay: wisp can carry HTTPS (cors false) but does not guarantee fullInternet, udp/icmp false', () => {
    expect(USER_RELAY_CAPABILITIES.transport.kind).toBe('wisp');
    expect(USER_RELAY_CAPABILITIES.transport.http).toBe(true);
    expect(USER_RELAY_CAPABILITIES.transport.https).toBe(true);
    expect(USER_RELAY_CAPABILITIES.transport.cors).toBe(false);
    expect(USER_RELAY_CAPABILITIES.guestStack.udp).toBe(false);
    expect(USER_RELAY_CAPABILITIES.guestStack.icmp).toBe(false);
    expect(USER_RELAY_CAPABILITIES.fullInternet).toBe(false);
  });

  it('local-proxy: local wisp (https true, cors false) with no fullInternet promise, udp false', () => {
    expect(LOCAL_PROXY_CAPABILITIES.transport.kind).toBe('wisp');
    expect(LOCAL_PROXY_CAPABILITIES.transport.http).toBe(true);
    expect(LOCAL_PROXY_CAPABILITIES.transport.https).toBe(true);
    expect(LOCAL_PROXY_CAPABILITIES.transport.cors).toBe(false);
    expect(LOCAL_PROXY_CAPABILITIES.guestStack.udp).toBe(false);
    expect(LOCAL_PROXY_CAPABILITIES.fullInternet).toBe(false);
    expect(capabilitiesForMode('local-proxy')).toBe(LOCAL_PROXY_CAPABILITIES);
  });

  it('local-network: unavailable as long as it is not implemented', () => {
    expect(Object.values(LOCAL_NETWORK_CAPABILITIES.nic).every((value) => value === false)).toBe(
      true,
    );
    expect(LOCAL_NETWORK_CAPABILITIES.transport.kind).toBe('none');
    expect(LOCAL_NETWORK_CAPABILITIES.fullInternet).toBe(false);
  });

  it('no mode promises full Internet without a runtime check', () => {
    for (const mode of NETWORK_MODES) {
      expect(capabilitiesForMode(mode).fullInternet).toBe(false);
    }
  });

  it('separates NIC, guest stack and transport', () => {
    expect(BROWSER_FETCH_CAPABILITIES.nic.ethernet).toBe(true);
    expect(BROWSER_FETCH_CAPABILITIES.guestStack.ip).toBe(true);
    expect(typeof BROWSER_FETCH_CAPABILITIES.transport.kind).toBe('string');
  });

  it('returns the capability set of the mode', () => {
    expect(capabilitiesForMode('offline')).toBe(OFFLINE_CAPABILITIES);
    expect(capabilitiesForMode('browser-fetch')).toBe(BROWSER_FETCH_CAPABILITIES);
    expect(capabilitiesForMode('user-relay')).toBe(USER_RELAY_CAPABILITIES);
    expect(capabilitiesForMode('local-proxy')).toBe(LOCAL_PROXY_CAPABILITIES);
    expect(capabilitiesForMode('local-network')).toBe(LOCAL_NETWORK_CAPABILITIES);
  });

  it('covers every declared mode', () => {
    for (const mode of NETWORK_MODES) {
      const capabilities = capabilitiesForMode(mode);
      expect(Object.values(capabilities.nic).length).toBeGreaterThan(0);
      expect(Object.values(capabilities.guestStack).length).toBeGreaterThan(0);
      expect(Object.values(capabilities.transport).length).toBeGreaterThan(0);
    }
  });
});
