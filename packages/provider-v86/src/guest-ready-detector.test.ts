import { describe, expect, it } from 'vitest';
import { GuestReadyDetector } from './guest-ready-detector';

const MARKER = 'LUMIBOOT_GUEST_READY:sample';

function readiness(marker: string = MARKER): { marker: string } {
  return { marker };
}

describe('GuestReadyDetector', () => {
  it('détecte le marqueur une seule fois, même émis octet par octet', () => {
    const detector = new GuestReadyDetector(readiness());
    let hits = 0;
    for (const char of MARKER) {
      if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    }
    expect(hits).toBe(1);
    expect(detector.detected).toBe(true);

    for (const char of MARKER) {
      if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    }
    expect(hits).toBe(1);
  });

  it('reconnaît un marqueur réparti sur deux notifications', () => {
    const detector = new GuestReadyDetector(readiness());
    const middle = Math.floor(MARKER.length / 2);
    const first = MARKER.slice(0, middle);
    const second = MARKER.slice(middle);

    let hits = 0;
    for (const char of first) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    for (const char of second) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    expect(hits).toBe(1);
  });

  it('garde un tampon borné face à de longs journaux du noyau', () => {
    const detector = new GuestReadyDetector(readiness());
    for (let index = 0; index < 100_000; index += 1) detector.pushByte(65);
    expect(detector.detected).toBe(false);
  });

  it('le marqueur d’une instance ne dépend pas d’un autre (plus de constante globale)', () => {
    const debian = new GuestReadyDetector({ marker: 'LUMIBOOT_GUEST_READY:debian' });
    const windows = new GuestReadyDetector({ marker: 'LUMIBOOT_GUEST_READY:windows' });

    for (const char of 'LUMIBOOT_GUEST_READY:windows') windows.pushByte(char.charCodeAt(0));
    expect(windows.detected).toBe(true);
    // Le marqueur Windows ne déclenche jamais l'instance Debian.
    expect(debian.detected).toBe(false);

    expect(debian.marker).toBe('LUMIBOOT_GUEST_READY:debian');
    expect(windows.marker).toBe('LUMIBOOT_GUEST_READY:windows');
  });

  it('expose le canal et le délai issus de readiness, avec défauts', () => {
    const explicit = new GuestReadyDetector({
      marker: MARKER,
      channel: 'vga',
      timeoutMs: 5000,
    });
    expect(explicit.channel).toBe('vga');
    expect(explicit.timeoutMs).toBe(5000);

    const defaults = new GuestReadyDetector({ marker: MARKER });
    expect(defaults.channel).toBe('serial');
    expect(defaults.timeoutMs).toBe(120_000);
  });

  it('expose le mode de preuve, avec `guest-marker` par défaut', () => {
    expect(new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' }).mode).toBe('disk-boot');
    expect(new GuestReadyDetector({ marker: MARKER }).mode).toBe('guest-marker');
  });

  it('décrit la preuve attendue selon le mode (étiquette disk-boot correcte)', () => {
    const marker = new GuestReadyDetector({ marker: MARKER, channel: 'vga' });
    expect(marker.describeExpectedProof()).toContain(MARKER);
    expect(marker.describeExpectedProof()).toContain('VGA');

    const disk = new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' });
    const description = disk.describeExpectedProof();
    expect(description).toMatch(/disque/i);
    // La preuve disque n'est jamais présentée comme un marqueur invité.
    expect(description).not.toContain(MARKER);
  });

  it('markDiskBoot ne prouve le démarrage disque qu’une seule fois', () => {
    const detector = new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' });
    expect(detector.markDiskBoot()).toBe(true);
    expect(detector.markDiskBoot()).toBe(false);
    expect(detector.detected).toBe(true);
  });

  it('rejette un marqueur vide', () => {
    expect(() => new GuestReadyDetector({ marker: '' })).toThrow();
  });
});
