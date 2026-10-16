import type {
  GuestReadiness,
  GuestReadinessChannel,
  GuestReadinessMode,
} from '@lumiboot/contracts';

/**
 * Détection du marqueur de disponibilité émis par le système invité.
 *
 * La balise est écrite par le système réellement démarré (unité systemd
 * `lumiboot-ready.service`, `ttyS0` par défaut). Elle ne doit JAMAIS être
 * produite côté JavaScript : elle est l'unique preuve que le noyau invité est
 * opérationnel, et donc la seule condition d'entrée dans l'état `running`.
 *
 * Correctif audit #20 : le marqueur, le canal et le délai proviennent du contrat
 * `readiness` du PROFIL (catalogue) et ne sont plus codés en dur. Le flux est lu
 * octet par octet : le marqueur peut être réparti sur plusieurs notifications,
 * on conserve donc un tampon borné, dimensionné sur la longueur du marqueur DE
 * L'INSTANCE (pas d'une constante globale).
 */
const DEFAULT_CHANNEL: GuestReadinessChannel = 'serial';
const DEFAULT_MODE: GuestReadinessMode = 'guest-marker';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Marge du tampon au-delà du marqueur, pour absorber le bruit du reste du flux. */
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
      throw new Error('Le marqueur de disponibilité invité ne peut pas être vide.');
    }
    this.#marker = readiness.marker;
    this.#tailLength = readiness.marker.length + EXTRA_TAIL_LENGTH;
    this.#channel = readiness.channel ?? DEFAULT_CHANNEL;
    this.#mode = readiness.mode ?? DEFAULT_MODE;
    this.#timeoutMs = readiness.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Marqueur attendu par cette instance. */
  get marker(): string {
    return this.#marker;
  }

  /** Canal surveillé (`serial` ou `vga`). */
  get channel(): GuestReadinessChannel {
    return this.#channel;
  }

  /** Mode de preuve (`guest-marker` par défaut, `disk-boot` pour un média importé). */
  get mode(): GuestReadinessMode {
    return this.#mode;
  }

  /** Délai maximal d'attente du marqueur, en millisecondes. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Consomme un octet du flux (série ou VGA). Retourne `true` une seule fois, au
   * moment exact où le marqueur complet devient présent dans le tampon.
   */
  pushByte(byte: number): boolean {
    if (this.#detected) return false;
    // Le marqueur est ASCII : aucun problème de frontière UTF-8 ici.
    this.#tail = (this.#tail + String.fromCharCode(byte & 0xff)).slice(-this.#tailLength);
    if (!this.#tail.includes(this.#marker)) return false;
    this.#detected = true;
    return true;
  }

  /**
   * Mode `disk-boot` : la preuve est une lecture réelle du disque dur, pas un
   * marqueur. Retourne `true` une seule fois, au premier accès disque observé.
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
