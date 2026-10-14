import { describe, expect, it } from 'vitest';
import { GUEST_READY_MARKER, GuestReadyDetector } from './guest-ready-detector';

describe('GuestReadyDetector', () => {
  it('détecte le marqueur une seule fois, même émis octet par octet', () => {
    const detector = new GuestReadyDetector();
    let hits = 0;
    for (const char of GUEST_READY_MARKER) {
      if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    }
    expect(hits).toBe(1);
    expect(detector.detected).toBe(true);

    for (const char of GUEST_READY_MARKER) {
      if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    }
    expect(hits).toBe(1);
  });

  it('reconnaît un marqueur réparti sur deux notifications', () => {
    const detector = new GuestReadyDetector();
    const middle = Math.floor(GUEST_READY_MARKER.length / 2);
    const first = GUEST_READY_MARKER.slice(0, middle);
    const second = GUEST_READY_MARKER.slice(middle);

    let hits = 0;
    for (const char of first) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    for (const char of second) if (detector.pushByte(char.charCodeAt(0))) hits += 1;
    expect(hits).toBe(1);
  });

  it('garde un tampon borné face à de longs journaux du noyau', () => {
    const detector = new GuestReadyDetector();
    for (let index = 0; index < 100_000; index += 1) detector.pushByte(65);
    expect(detector.detected).toBe(false);
  });
});
