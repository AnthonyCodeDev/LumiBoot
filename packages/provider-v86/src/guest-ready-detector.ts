import type {
  GuestReadiness,
  GuestReadinessChannel,
  GuestReadinessMode,
} from '@lumiboot/contracts';

/**
 * Detects the guest boot proof declared by the profile `readiness` contract.
 *
 * `disk-boot` only attests BIOS activity and is never a guest marker.
 */
const DEFAULT_CHANNEL: GuestReadinessChannel = 'serial';
const DEFAULT_MODE: GuestReadinessMode = 'guest-marker';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Absorbs noise from the rest of the stream after the marker. */
const EXTRA_TAIL_LENGTH = 64;

export class GuestReadyDetector {
  #tail = '';
  #detected = false;
  readonly #marker: string;
  readonly #tailLength: number;
  readonly #channel: GuestReadinessChannel;
  readonly #mode: GuestReadinessMode;
  readonly #timeoutMs: number;

  constructor(readiness: GuestReadiness) {
    if (readiness.marker.length === 0) {
      throw new Error('The guest readiness marker cannot be empty.');
    }
    this.#marker = readiness.marker;
    this.#tailLength = readiness.marker.length + EXTRA_TAIL_LENGTH;
    this.#channel = readiness.channel ?? DEFAULT_CHANNEL;
    this.#mode = readiness.mode ?? DEFAULT_MODE;
    this.#timeoutMs = readiness.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Marker expected by this instance. */
  get marker(): string {
    return this.#marker;
  }

  get channel(): GuestReadinessChannel {
    return this.#channel;
  }

  /** `guest-marker` by default; `disk-boot` for BIOS-booted media. */
  get mode(): GuestReadinessMode {
    return this.#mode;
  }

  /** Maximum wait for the proof, in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /** Labels a `disk-boot` proof as a disk read, never as a guest marker. */
  describeExpectedProof(): string {
    if (this.#mode === 'disk-boot') {
      return 'the first read of the hard disk (hda)';
    }
    const channel = this.#channel === 'vga' ? 'VGA' : 'serial';
    return `the marker "${this.#marker}" on the ${channel} channel`;
  }

  /**
   * Consumes one byte; `true` only once, when the full marker is present.
   */
  pushByte(byte: number): boolean {
    if (this.#detected) return false;
    // The marker is ASCII: no UTF-8 boundary issue.
    this.#tail = (this.#tail + String.fromCharCode(byte & 0xff)).slice(-this.#tailLength);
    if (!this.#tail.includes(this.#marker)) return false;
    this.#detected = true;
    return true;
  }

  /** `true` once, on the first hard disk read; weaker than a marker. */
  markDiskBoot(): boolean {
    if (this.#detected) return false;
    this.#detected = true;
    return true;
  }

  get detected(): boolean {
    return this.#detected;
  }
}
