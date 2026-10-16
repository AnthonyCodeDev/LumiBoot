import type {
  GuestReadiness,
  GuestReadinessChannel,
  GuestReadinessMode,
} from '@lumiboot/contracts';

/**
 * Détection de la preuve de démarrage invité.
 *
 * Deux modes, tous deux adossés au contrat `readiness` du PROFIL (catalogue) :
 *
 * - `guest-marker` : la balise est écrite par le système réellement démarré
 *   (unité systemd `lumiboot-ready.service`, `ttyS0` par défaut). Elle ne doit
 *   JAMAIS être produite côté JavaScript : c'est l'UNIQUE preuve d'un OS
 *   opérationnel. Son absence dans le délai n'est jamais un `running` : c'est un
 *   échec non vérifié (voir `V86Instance`).
 * - `disk-boot` : aucun marqueur n'existe (média importé/BIOS). La preuve est une
 *   lecture réelle du disque dur (`hda`). Elle est PLUS FAIBLE : elle atteste une
 *   activité d'amorçage, pas un OS opérationnel. Elle ne doit jamais être
 *   présentée comme un marqueur invité.
 *
 * Correctif audit #20 : le marqueur, le canal et le délai proviennent du contrat
 * `readiness` et ne sont plus codés en dur. Le flux est lu octet par octet : le
 * marqueur peut être réparti sur plusieurs notifications, on conserve donc un
 * tampon borné, dimensionné sur la longueur du marqueur DE L'INSTANCE (pas d'une
 * constante globale).
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

  /** Délai maximal d'attente de la preuve, en millisecondes. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Description factuelle de la preuve attendue par cette instance. Sert aux
   * messages d'échec : un profil `disk-boot` est étiqueté comme tel (lecture
   * disque) et n'est jamais présenté comme un marqueur invité.
   */
  describeExpectedProof(): string {
    if (this.#mode === 'disk-boot') {
      return 'la première lecture du disque dur (hda)';
    }
    const channel = this.#channel === 'vga' ? 'VGA' : 'série';
    return `le marqueur « ${this.#marker} » sur le canal ${channel}`;
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
   * marqueur invité. Retourne `true` une seule fois, au premier accès disque
   * observé. Cette preuve reste plus faible qu'un marqueur (voir doc de classe).
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
