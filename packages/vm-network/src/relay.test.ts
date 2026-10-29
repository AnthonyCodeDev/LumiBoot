import { describe, expect, it } from 'vitest';
import { validateRelayUrl } from './relay';
import {
  HOSTILE_ORIGIN,
  RELAY_PUBLIC,
  RELAY_WSS,
  RELAY_WSS_PORT,
  RELAY_WS_LOCAL,
} from './testing/fixtures';

describe('validateRelayUrl', () => {
  it('accepts a wss address with host and port', () => {
    const result = validateRelayUrl(RELAY_WSS_PORT);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${RELAY_WSS_PORT}/`);
  });

  it('normalizes a wss address', () => {
    const result = validateRelayUrl(RELAY_WSS);
    expect(result.ok).toBe(true);
    expect(result.url).toBe(`${RELAY_WSS}/`);
  });

  it('rejects ws:// by default', () => {
    expect(validateRelayUrl(RELAY_WSS.replace('wss://', 'ws://')).ok).toBe(false);
  });

  it('rejects http and https', () => {
    expect(validateRelayUrl(HOSTILE_ORIGIN).ok).toBe(false);
    expect(validateRelayUrl(RELAY_PUBLIC).ok).toBe(false);
  });

  it('rejects an empty or non-string address', () => {
    expect(validateRelayUrl('').ok).toBe(false);
    expect(validateRelayUrl('   ').ok).toBe(false);
    expect(validateRelayUrl(undefined).ok).toBe(false);
    expect(validateRelayUrl(42).ok).toBe(false);
  });

  it('rejects credentials (userinfo)', () => {
    expect(validateRelayUrl(RELAY_WSS.replace('://', '://user:pass@')).ok).toBe(false);
    expect(validateRelayUrl(RELAY_WSS.replace('://', '://user@')).ok).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(validateRelayUrl(`${RELAY_WSS}#frag`).ok).toBe(false);
  });

  it('rejects a malformed address', () => {
    expect(validateRelayUrl('not a url').ok).toBe(false);
    expect(validateRelayUrl('wss://').ok).toBe(false);
  });

  it('allows ws:// on localhost only with allowInsecure', () => {
    expect(validateRelayUrl(RELAY_WS_LOCAL, { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl('ws://127.0.0.1:1234', { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl(RELAY_WS_LOCAL).ok).toBe(false);
    expect(validateRelayUrl('ws://example.com', { allowInsecure: true }).ok).toBe(false);
  });
});
