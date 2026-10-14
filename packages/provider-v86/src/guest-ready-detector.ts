/**
 * Détection du marqueur de disponibilité émis par le système invité.
 *
 * La balise est écrite sur le port série `ttyS0` par le système réellement
 * démarré (unité systemd `lumiboot-ready.service`). Elle ne doit JAMAIS être
 * produite côté JavaScript : elle est l'unique preuve que le noyau invité est
 * opérationnel, et donc la seule condition d'entrée dans l'état `running`.
 *
 * Le flux est lu octet par octet (événement `serial0-output-byte`) : le
 * marqueur peut donc être réparti sur plusieurs notifications. On conserve un
 * tampon borné pour reconnaître la balise même en cas de fragmentation tout en
 * évitant une croissance mémoire illimitée sur les longs logs du noyau.
 */
export const GUEST_READY_MARKER = 'LUMIBOOT_GUEST_READY:debian-12-i386';

const TAIL_LENGTH = GUEST_READY_MARKER.length + 64;

export class GuestReadyDetector {
  #tail = '';
  #detected = false;
  readonly #marker: string;

  constructor(marker: string = GUEST_READY_MARKER) {
    this.#marker = marker;
  }

  /**
   * Consomme un octet du flux série. Retourne `true` une seule fois, au moment
   * exact où le marqueur complet devient présent dans le tampon.
   */
  pushByte(byte: number): boolean {
    if (this.#detected) return false;
    // Le marqueur est ASCII : aucun problème de frontière UTF-8 ici.
    this.#tail = (this.#tail + String.fromCharCode(byte & 0xff)).slice(-TAIL_LENGTH);
    if (!this.#tail.includes(this.#marker)) return false;
    this.#detected = true;
    return true;
  }

  get detected(): boolean {
    return this.#detected;
  }
}
