import { describe, expect, it } from 'vitest';
import { validateRelayUrl } from './relay';

describe('validateRelayUrl', () => {
  it('accepte une adresse wss avec hôte et port', () => {
    const result = validateRelayUrl('wss://relay.example:8443');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('wss://relay.example:8443/');
  });

  it('normalise une adresse wss', () => {
    const result = validateRelayUrl('wss://relay.example');
    expect(result.ok).toBe(true);
    expect(result.url).toBe('wss://relay.example/');
  });

  it('rejette ws:// par défaut', () => {
    expect(validateRelayUrl('ws://relay.example').ok).toBe(false);
  });

  it('rejette http et https', () => {
    expect(validateRelayUrl('http://relay.example').ok).toBe(false);
    expect(validateRelayUrl('https://relay.example').ok).toBe(false);
  });

  it('rejette une adresse vide ou non textuelle', () => {
    expect(validateRelayUrl('').ok).toBe(false);
    expect(validateRelayUrl('   ').ok).toBe(false);
    expect(validateRelayUrl(undefined).ok).toBe(false);
    expect(validateRelayUrl(42).ok).toBe(false);
  });

  it('rejette les identifiants (userinfo)', () => {
    expect(validateRelayUrl('wss://user:pass@relay.example').ok).toBe(false);
    expect(validateRelayUrl('wss://user@relay.example').ok).toBe(false);
  });

  it('rejette un fragment', () => {
    expect(validateRelayUrl('wss://relay.example#frag').ok).toBe(false);
  });

  it('rejette une adresse mal formée', () => {
    expect(validateRelayUrl('not a url').ok).toBe(false);
    expect(validateRelayUrl('wss://').ok).toBe(false);
  });

  it('autorise ws:// sur localhost uniquement avec allowInsecure', () => {
    expect(validateRelayUrl('ws://localhost:1234', { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl('ws://127.0.0.1:1234', { allowInsecure: true }).ok).toBe(true);
    expect(validateRelayUrl('ws://localhost:1234').ok).toBe(false);
    expect(validateRelayUrl('ws://example.com', { allowInsecure: true }).ok).toBe(false);
  });
});
