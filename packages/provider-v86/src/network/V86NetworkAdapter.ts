import { DEFAULT_HARDWARE_PROFILE, type HardwareProfile } from '@lumiboot/contracts';
import {
  DEFAULT_PROXY_URL,
  NetworkError,
  buildProxyWispUrl,
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
 * Mapping LumiBoot -> v86, vérifié dans la version installée
 * `v86@0.5.471+g94faf3d` (`node_modules/v86/build/libv86.mjs`).
 *
 * v86 résout `options.network_relay_url || options.net_device.relay_url` ainsi :
 *   - `"fetch"`      -> backend fetch natif du navigateur (classe `Xb`) ;
 *   - `"inbrowser"`  -> backend réseau en mémoire (classe `rc`) ;
 *   - `"wisp://…"`   -> client Wisp au-dessus de `ws://` (classe `$b`) ;
 *   - `"wisps://…"`  -> client Wisp au-dessus de `wss://` (classe `$b`) ;
 *   - tout autre     -> relais WebSocket historique (classe `pb`).
 *
 * Modes LumiBoot :
 *   - `offline` / `browser-fetch` / `user-relay` : voir
 *     {@link toV86NetworkDevice} ;
 *   - `local-proxy` : relais WISP local du proxy réseau local
 *     (`wisp://127.0.0.1:37892/wisp/`), dérivé de `proxyUrl` (+ token
 *     runtime `proxyToken`) via `buildProxyWispUrl`, puis converti par
 *     `toWispRelayUrl` comme les autres relais.
 *
 * `network_relay_url` est marqué `@deprecated` dans `v86.d.ts` au profit de
 * `net_device` : LumiBoot n'utilise donc que `net_device.relay_url`.
 *
 * Le client Wisp construit son WebSocket via `$b.prototype.register_ws` :
 *   `new WebSocket(url.replace("wisp://","ws://").replace("wisps://","wss://"))`
 * `wisps://` est donc le schéma d'un relais Wisp **TLS** (`wss://`), et une URL
 * `wss://…` brute n'est PAS reconnue comme Wisp (elle tomberait sur le relais
 * historique `pb`). LumiBoot valide ses relais en `wss://`
 * ({@link validateRelayUrl}), on convertit donc fidèlement :
 *   - `wss://host:port/path[…]` -> `wisps://host:port/path[…]` ;
 *   - `ws://host:port/path[…]`  -> `wisp://host:port/path[…]` (uniquement si la
 *     validation a explicitement toléré le `ws:` localhost ; le provider ne
 *     l'active jamais, donc ce cas reste hors du chemin nominal).
 *
 * `validation.url` provient de `URL.href` : port et chemin sont déjà normalisés
 * et préservés tels quels, v86 ne réclame aucune retouche supplémentaire.
 */
function toWispRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^wss:/i, 'wisps:').replace(/^ws:/i, 'wisp:');
}

/**
 * Construit la carte réseau v86 correspondant à un profil LumiBoot.
 *
 * Le champ `type` (NIC) n'est pas fixé ici : il provient du PROFIL MATÉRIEL du
 * catalogue et est fusionné par le provider via
 * {@link toV86NetworkDeviceType}.
 *
 * @throws NetworkError `NETWORK_INVALID_RELAY_URL` en mode `user-relay` sans
 *   adresse `wss://` valide, `NETWORK_INVALID_PROXY_URL` en mode
 *   `local-proxy` sans adresse loopback valide, `NETWORK_UNSUPPORTED_MODE`
 *   en mode `local-network`.
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
    case 'local-proxy': {
      let url: string;
      try {
        url = buildProxyWispUrl(profile.proxyUrl ?? DEFAULT_PROXY_URL, profile.proxyToken);
      } catch (error) {
        throw new NetworkError(
          'NETWORK_INVALID_PROXY_URL',
          error instanceof Error ? error.message : 'Adresse du proxy réseau local invalide.',
        );
      }
      return { relay_url: toWispRelayUrl(url) };
    }
    case 'local-network':
      throw new NetworkError(
        'NETWORK_UNSUPPORTED_MODE',
        "Le mode « local-network » n'est pas encore implémenté pour v86.",
      );
  }
}

/**
 * Traduit la carte réseau du PROFIL MATÉRIEL (`HardwareProfile.network`) vers le
 * type attendu par v86 (`net_device.type`).
 *
 * Correctif audit #18 : le provider ne décide plus de la carte par `id`/famille
 * ou par une heuristique `family`+`architecture` ; il ne fait que LIRE le
 * contrat du catalogue et le traduire. `none` signifie « aucune carte ».
 *
 * `undefined` (profil matériel absent) retombe sur le défaut documenté
 * `'virtio'`.
 */
const DEVICE_TYPE_BY_NETWORK: Readonly<
  Record<HardwareProfile['network'], V86NetworkDeviceType | undefined>
> = {
  virtio: 'virtio',
  ne2k: 'ne2k',
  none: undefined,
};

export function toV86NetworkDeviceType(
  hardware: HardwareProfile | undefined,
): V86NetworkDeviceType | undefined {
  const network = hardware?.network ?? DEFAULT_HARDWARE_PROFILE.network;
  return DEVICE_TYPE_BY_NETWORK[network];
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
