import type {
  GuestReadiness,
  GuestReadinessChannel,
  GuestReadinessMode,
} from '@lumiboot/contracts';

/**
 * Detection of the guest boot proof.
 *
 * Two modes, both backed by the `readiness` contract of the PROFILE (catalog):
 *
 * - `guest-marker`: the tag is written by the system that actually booted
 *   (systemd unit `lumiboot-ready.service`, `ttyS0` by default). It must NEVER be
 *   produced by JavaScript: it is the ONLY proof of an operational OS. Its
 *   absence within the delay is never a `running`: it is an unverified failure
 *   (see `V86Instance`).
 * - `disk-boot`: no marker exists (imported media/BIOS). The proof is a real read
 *   of the hard disk (`hda`). It is WEAKER: it attests boot activity, not an
 *   operational OS. It must never be presented as a guest marker.
 *
 * Audit fix #20: the marker, channel and delay come from the `readiness`
 * contract and are no longer hard-coded. The stream is read byte by byte: the
 * marker can be split across several notifications, so a bounded buffer is kept,
 * sized on the marker length OF THE INSTANCE (not on a global constant).
 */
const DEFAULT_CHANNEL: GuestReadinessChannel = 'serial';
const DEFAULT_MODE: GuestReadinessMode = 'guest-marker';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Buffer margin beyond the marker, to absorb noise from the rest of the stream. */
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

  /** Watched channel (`serial` or `vga`). */
  get channel(): GuestReadinessChannel {
    return this.#channel;
  }

  /** Proof mode (`guest-marker` by default, `disk-boot` for an imported media). */
  get mode(): GuestReadinessMode {
    return this.#mode;
  }

  /** Maximum wait for the proof, in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Factual description of the proof expected by this instance. Used in failure
   * messages: a `disk-boot` profile is labeled as such (disk read) and is never
   * presented as a guest marker.
   */
  describeExpectedProof(): string {
    if (this.#mode === 'disk-boot') {
      return 'the first read of the hard disk (hda)';
    }
    const channel = this.#channel === 'vga' ? 'VGA' : 'serial';
    return `the marker "${this.#marker}" on the ${channel} channel`;
  }

  /**
   * Consumes one byte from the stream (serial or VGA). Returns `true` only once,
   * at the exact moment the complete marker becomes present in the buffer.
   */
  pushByte(byte: number): boolean {
    if (this.#detected) return false;
    // The marker is ASCII: no UTF-8 boundary issue here.
    this.#tail = (this.#tail + String.fromCharCode(byte & 0xff)).slice(-this.#tailLength);
    if (!this.#tail.includes(this.#marker)) return false;
    this.#detected = true;
    return true;
  }

  /**
   * `disk-boot` mode: the proof is a real hard disk read, not a guest marker.
   * Returns `true` only once, on the first observed disk access. This proof stays
   * weaker than a marker (see class doc).
   */
  markDiskBoot(): boolean {
    if (this.#detected) return false;
    this.#detected = true;
    return true;
  }

  get detected(): boolean {
    return this.#detected;
  }
}
