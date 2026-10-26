import { describe, expect, it } from 'vitest';
import { validateRelayUrl } from './relay';

describe('validateRelayUrl', () => {
  it('accepts a wss address with host and port', () => {
    const result = validateRelayUrl('wss://relay.example:8443');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('wss://relay.example:8443/');
  });

  it('normalizes a wss address', () => {
    const result = validateRelayUrl('wss://relay.example');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('wss://relay.example/');
  });

  it('rejects ws:// by default', () => {
    expect(validateRelayUrl('ws://relay.example').ok).toBe(false);
  });

  it('rejects http and https', () => {
    expect(validateRelayUrl('http://relay.example').ok).toBe(false);
    expect(validateRelayUrl('https://relay.example').ok).toBe(false);
  });

  it('rejects an empty or non-string address', () => {
    expect(validateRelayUrl('').ok).toBe(false);
    expect(validateRelayUrl('   ').ok).toBe(false);
    expect(validateRelayUrl(undefined).ok).toBe(false);
    expect(validateRelayUrl(42).ok).toBe(false);
  });

  it('rejects credentials (userinfo)', () => {
    expect(validateRelayUrl('wss://user:pass@relay.example').ok).toBe(false);
    expect(validateRelayUrl('wss://user@relay.example').ok).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(validateRelayUrl('wss://relay.example#frag').ok).toBe(false);
  });

  it('rejects a malformed address', () => {
    expect(validateRelayUrl('not a url').ok).toBe(false);
    expect(validateRelayUrl('wss://').ok).toBe(false);
  });

  it('allows ws:// on localhost only with allowInsecure', () => {
    expect(validateRelayUrl('ws://localhost:1234', { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl('ws://127.0.0.1:1234', { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl('ws://localhost:1234').ok).toBe(false);
    expect(validateRelayUrl('ws://example.com', { allowInsecure: true }).ok).toBe(false);
  });
});
