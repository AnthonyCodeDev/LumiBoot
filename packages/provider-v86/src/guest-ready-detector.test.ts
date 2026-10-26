import { describe, expect, it } from 'vitest';
import { GuestReadyDetector } from './guest-ready-detector';

const MARKER = 'LUMIBOOT_GUEST_READY:sample';

function readiness(marker: string = MARKER): { marker: string } {
  return { marker };
}

describe('GuestReadyDetector', () => {
  it('detects the marker only once, even when emitted byte by byte', () => {
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

  it('recognizes a marker split across two notifications', () => {
    const detector = new GuestReadyDetector(readiness());
    const middle = Math.floor(MARKER.length / 2);
    const first = MARKER.slice(0, middle);
    const second = MARKER.slice(middle);

    let hits = 0;
    for (const char of first) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    for (const char of second) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    expect(hits).toBe(1);
  });

  it('keeps a bounded buffer against long kernel logs', () => {
    const detector = new GuestReadyDetector(readiness());
    for (let index = 0; index < 100_000; index += 1) detector.pushByte(65);
    expect(detector.detected).toBe(false);
  });

  it('the marker of an instance does not depend on another (no global constant)', () => {
    const debian = new GuestReadyDetector({ marker: 'LUMIBOOT_GUEST_READY:debian' });
    const windows = new GuestReadyDetector({ marker: 'LUMIBOOT_GUEST_READY:windows' });

    for (const char of 'LUMIBOOT_GUEST_READY:windows') windows.pushByte(char.charCodeAt(0));
    expect(windows.detected).toBe(true);
    // The Windows marker never triggers the Debian instance.
    expect(debian.detected).toBe(false);

    expect(debian.marker).toBe('LUMIBOOT_GUEST_READY:debian');
    expect(windows.marker).toBe('LUMIBOOT_GUEST_READY:windows');
  });

  it('exposes the channel and the delay from readiness, with defaults', () => {
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

  it('exposes the proof mode, defaulting to `guest-marker`', () => {
    expect(new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' }).mode).toBe('disk-boot');
    expect(new GuestReadyDetector({ marker: MARKER }).mode).toBe('guest-marker');
  });

  it('describes the expected proof depending on the mode (correct disk-boot label)', () => {
    const marker = new GuestReadyDetector({ marker: MARKER, channel: 'vga' });
    expect(marker.describeExpectedProof()).toContain(MARKER);
    expect(marker.describeExpectedProof()).toContain('VGA');

    const disk = new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' });
    const description = disk.describeExpectedProof();
    expect(description).toMatch(/disk/i);
    // The disk proof is never presented as a guest marker.
    expect(description).not.toContain(MARKER);
  });

  it('markDiskBoot proves the disk boot only once', () => {
    const detector = new GuestReadyDetector({ marker: MARKER, mode: 'disk-boot' });
    expect(detector.markDiskBoot()).toBe(true);
    expect(detector.markDiskBoot()).toBe(false);
    expect(detector.detected).toBe(true);
  });

  it('rejects an empty marker', () => {
    expect(() => new GuestReadyDetector({ marker: '' })).toThrow();
  });
});
