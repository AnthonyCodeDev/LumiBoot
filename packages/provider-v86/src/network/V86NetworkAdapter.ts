import type { OSDefinition } from '@lumiboot/contracts';
import {
  NetworkError,
  validateRelayUrl,
  type NetworkController,
  type NetworkProfile,
} from '@lumiboot/vm-network';
import type { Event as V86Event, V86Options } from 'v86';

/**
 * Traduction des profils réseau LumiBoot vers la couche réseau de v86.
 *
 * Ce module est volontairement isolé : aucune dépendance à React, aucune
 * dépendance à un système invité particulier (Debian ou autre). Il constitue
 * l'unique point de contact entre `@lumiboot/vm-network` et `v86`.
 */

/** Carte réseau v86 (`V86NetworkDevice` n'est pas exporté directement par v86). */
export type V86NetworkDevice = NonNullable<V86Options['net_device']>;

/** Type de carte émulée fournie au système invité. */
export type V86NetworkDeviceType = NonNullable<V86NetworkDevice['type']>;

/** Événements réseau exploités pour les diagnostics (cf. `V86Event`). */
export type V86NetworkEventName = 'eth-transmit-end' | 'eth-receive-end' | 'net0-send';

/**
 * Source d'événements minimale : uniquement les notifications réseau utiles aux
 * diagnostics. `V86` y satisfait structurellement, et un émetteur de test n'a
 * pas besoin d'implémenter tout l'émulateur.
 */
export interface NetworkEventSource {
  add_listener<T extends V86NetworkEventName>(
    event: T,
    listener: (argument: V86Event[T]) => void,
  ): void;
  remove_listener<T extends V86NetworkEventName>(
    event: T,
    listener: (argument: V86Event[T]) => void,
  ): void;
}

/**
 * Mapping LumiBoot -> v86, vérifié dans la version installée `v86@0.5.471`.
 *
 * `libv86.mjs` résout `relay_url` (`V86Options.net_device.relay_url`) ainsi :
 *   - `"fetch"`      -> backend fetch natif du navigateur (classe `Xb`) ;
 *   - `"inbrowser"`  -> backend réseau en mémoire (classe `rc`) ;
 *   - `"wisp://..."` -> client Wisp au-dessus de `ws://` (classe `$b`) ;
 *   - `"wisps://..."`-> client Wisp au-dessus de `wss://` (classe `$b`) ;
 *   - tout autre     -> relais WebSocket historique (classe `pb`).
 *
 * Le client Wisp de v86 réécrit `wisp://` en `ws://` et `wisps://` en `wss://`
 * (`register_ws`). LumiBoot valide ses relais en `wss://` (seul `ws://` localhost
 * est toléré en développement), on convertit donc fidèlement :
 *   - `wss://host:port/path[...]` -> `wisps://host:port/path[...]` ;
 *   - `ws://host:port/path[...]`  -> `wisp://host:port/path[...]`.
 *
 * Aucune constante magique : tout ce que v86 comprend est accepté tel quel.
 */
function toWispRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^wss:/i, 'wisps:').replace(/^ws:/i, 'wisp:');
}

/**
 * Construit la carte réseau v86 correspondant à un profil LumiBoot.
 *
 * Le champ `type` (NIC) n'est pas fixé ici : il dépend du système invité et est
 * fusionné par le provider via {@link selectNetworkDeviceType}.
 *
 * @throws NetworkError `NETWORK_INVALID_RELAY_URL` en mode `user-relay` sans
 *   adresse `wss://` valide, `NETWORK_UNSUPPORTED_MODE` en mode `local-network`.
 */
export function toV86NetworkDevice(profile: NetworkProfile): V86NetworkDevice | undefined {
  switch (profile.mode) {
    case 'offline':
      return undefined;
    case 'browser-fetch':
      return { relay_url: 'fetch' };
    case 'user-relay': {
      const validation = validateRelayUrl(profile.relayUrl);
      if (!validation.ok || validation.url === undefined) {
        throw new NetworkError(
          'NETWORK_INVALID_RELAY_URL',
          validation.error ?? 'Adresse de relais invalide.',
        );
      }
      return { relay_url: toWispRelayUrl(validation.url) };
    }
    case 'local-network':
      throw new NetworkError(
        'NETWORK_UNSUPPORTED_MODE',
        "Le mode « local-network » n'est pas encore implémenté pour v86.",
      );
  }
}

/**
 * Profil matériel réseau : regroupe les invités qui partagent le MÊME support
 * de pilote NIC sous v86. Le choix ne dépend donc pas de la seule famille
 * Linux/Windows, mais d'une décision par système (voir ci-dessous).
 */
type NetworkDeviceProfile = 'virtio-net' | 'legacy-ne2k';

/** Carte v86 associée à chaque profil matériel. */
const DEVICE_BY_PROFILE: Readonly<Record<NetworkDeviceProfile, V86NetworkDeviceType>> = {
  // Noyaux modernes : `virtio-net` natif, recommandé par v86 (meilleures perfs).
  'virtio-net': 'virtio',
  // Invités anciens : pilotes virtio absents/instables, `ne2k` (NE2000) est le
  // dénominateur commun (Windows 9x/DOS, vieux noyaux).
  'legacy-ne2k': 'ne2k',
};

/**
 * Table de résolution par identifiant de système : source de vérité pour les
 * invités explicitement validés. Toute entrée absente retombe sur
 * {@link profileForHardware}. Documenter ici chaque nouveau système confirmé.
 */
const PROFILE_BY_SYSTEM_ID: Readonly<Record<string, NetworkDeviceProfile>> = Object.freeze({
  // Debian 12 Bookworm : noyau 6.x, `virtio-net` natif (choix historique conservé).
  'debian-12-i386': 'virtio-net',
  // Ubuntu 18.04 : noyau 4.15, virtio-net natif.
  'ubuntu-18-i386': 'virtio-net',
  // Windows 7 x86 : invité ancien, pilotes virtio fragiles sous v86.
  'windows-7-x86': 'legacy-ne2k',
});

/**
 * Heuristique matérielle de repli, appliquée quand l'`id` n'est pas tabulé :
 * un Windows 32 bits est traité comme invité ancien (`ne2k`) ; tout le reste
 * reçoit `virtio`, valeur par défaut adaptée à v86 (noyaux Linux modernes).
 */
function profileForHardware(
  os: Pick<OSDefinition, 'family' | 'architecture'>,
): NetworkDeviceProfile {
  const legacyWindows =
    os.family === 'windows' && (os.architecture === 'i386' || os.architecture === 'x86');
  return legacyWindows ? 'legacy-ne2k' : 'virtio-net';
}

/**
 * Résout la carte réseau émulée (`ne2k` ou `virtio`) pour un système donné.
 *
 * Ordre de résolution, du plus spécifique au plus général :
 *   1. `override` explicite (surcharge issue du profil réseau/de la config) ;
 *   2. table {@link PROFILE_BY_SYSTEM_ID} (par `os.id`, décisions validées) ;
 *   3. heuristique {@link profileForHardware} (`family` + `architecture`) ;
 *   4. défaut v86 : `virtio`.
 *
 * Ainsi un même `family` peut recevoir un NIC différent selon son `id`/`arch`,
 * et LumiBoot réserve `virtio` à Debian 12 (`debian-12-i386`) sans le généraliser.
 *
 * @param os Système invité (au minimum `id`/`family`/`architecture`) ;
 *   un `OSDefinition` complet satisfait la contrainte.
 * @param override Carte imposée par l'appelant (surcharge config/profil) ; si
 *   fournie, elle prime sur la table et l'heuristique.
 */
export function resolveNetworkDevice(
  os: Pick<OSDefinition, 'id' | 'family' | 'architecture'>,
  override?: V86NetworkDeviceType,
): V86NetworkDeviceType {
  if (override !== undefined) return override;
  const profile = PROFILE_BY_SYSTEM_ID[os.id] ?? profileForHardware(os);
  return DEVICE_BY_PROFILE[profile];
}

/**
 * Alias historique conservé pour `V86Provider` (comportement inchangé).
 * Toute nouvelle logique doit passer par {@link resolveNetworkDevice}.
 *
 * @deprecated Utiliser {@link resolveNetworkDevice} (surcharge possible).
 */
export function selectNetworkDeviceType(os: OSDefinition): V86NetworkDeviceType {
  return resolveNetworkDevice(os);
}

/**
 * Branche les compteurs de trafic réseau sur les événements réels de v86.
 *
 * v86 publie DEUX notifications pour chaque trame sortante : `net0-send` (trame
 * brute émise par la carte) puis `eth-transmit-end` (fin de transmission, avec
 * le nombre d'octets). Les compter toutes deux doublerait le trafic : on
 * privilégie `net0-send` et `eth-transmit-end` ne sert que de repli tant
 * qu'aucune trame `net0-send` n'a été observée. `eth-receive-end` alimente la
 * réception.
 *
 * @returns une fonction de détachement (retire les trois écouteurs).
 */
export function attachNetworkDiagnostics(
  emulator: NetworkEventSource,
  controller: NetworkController,
): () => void {
  let observedFrameSend = false;

  const onTransmitEnd = (argument: V86Event['eth-transmit-end']): void => {
    if (observedFrameSend) return;
    controller.reportTx(argument[0]);
  };
  const onReceiveEnd = (argument: V86Event['eth-receive-end']): void => {
    controller.reportRx(argument[0]);
  };
  const onFrameSend = (frame: V86Event['net0-send']): void => {
    observedFrameSend = true;
    controller.reportTx(frame.byteLength);
  };

  emulator.add_listener('eth-transmit-end', onTransmitEnd);
  emulator.add_listener('eth-receive-end', onReceiveEnd);
  emulator.add_listener('net0-send', onFrameSend);

  return () => {
    emulator.remove_listener('eth-transmit-end', onTransmitEnd);
    emulator.remove_listener('eth-receive-end', onReceiveEnd);
    emulator.remove_listener('net0-send', onFrameSend);
  };
}
