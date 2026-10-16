# Réseau

`@lumiboot/vm-network` centralise les modes, profils, capacités, diagnostics et cycles de vie. `provider-v86` convertit le profil retenu en configuration `net_device`.

## Modes

| Mode | Transport | Limites |
|---|---|---|
| `offline` | aucun | aucune NIC |
| `browser-fetch` | Fetch de v86 | HTTP 80, CORS, pas de HTTPS/UDP/ICMP |
| `local-proxy` | WISP V1 vers `127.0.0.1:37892` | appairage requis, TCP sortant uniquement |
| `user-relay` | WISP en `wss://` | relais fourni et administré par l'utilisateur |
| `local-network` | aucun | prévu, non implémenté |

`local-network` désigne un réseau virtuel entre invités, pas le LAN physique de l'hôte.

Un invité **Windows** n'a pas de pilote NE2000 en standard : le pilote réseau doit être installé dans son image avant utilisation, sinon aucun réseau n'apparaît. Voir [`windows-7.md`](windows-7.md).

## Niveau de preuve

- Configuré : le profil est valide et sélectionné.
- Supporté : `capabilitiesForMode()` déclare une capacité théorique.
- Vérifié : une sonde exécutée dans l'invité a réussi.

Une WebSocket ouverte ou des compteurs `txBytes`/`rxBytes` non nuls ne prouvent pas Internet. `fullInternet` reste `false` par défaut.

## Configuration

Le fichier public `apps/web/public/lumiboot.config.json` est chargé au démarrage. Un profil par système remplace le profil par défaut :

```json
{
  "version": 1,
  "network": {
    "defaultProfile": { "mode": "browser-fetch" },
    "systems": {
      "debian-12-i386": { "mode": "browser-fetch" }
    }
  },
  "proxy": { "enabled": true }
}
```

Ne placer aucun secret dans ce fichier. Le profil est appliqué avant la création de v86 ; changer de mode impose une nouvelle session.

### Relais WISP utilisateur

```json
{
  "mode": "user-relay",
  "relayUrl": "wss://relay.example.org/"
}
```

L'URL doit utiliser `wss://`. `ws://` n'est accepté qu'en développement sur localhost. Un WebSocket ordinaire n'est pas nécessairement un relais WISP.

### Proxy local

Le frontend détecte le proxy, demande un appairage, vérifie le token puis remplace automatiquement `browser-fetch` par `local-proxy`. Les profils `offline` et `user-relay` restent prioritaires. Voir [`network-proxy.md`](network-proxy.md).

## Vérification depuis Debian

```bash
ip -br addr
getent hosts deb.debian.org
curl -I http://deb.debian.org/
curl -I https://deb.debian.org/
```

Avec `browser-fetch`, seul HTTP peut réussir et reste soumis à CORS. Avec un proxy ou relais WISP valide, HTTPS et le TCP sortant peuvent fonctionner ; UDP et ICMP ne sont pas annoncés.

## Cycle de vie

Chaque session possède son contrôleur. `start()` accepte un `AbortSignal`; `stop()` et `dispose()` sont idempotents. La destruction retire les listeners v86 et ferme le transport associé.

Décisions : [`adr/0005-network-universal.md`](adr/0005-network-universal.md), [`adr/0007-network-proxy.md`](adr/0007-network-proxy.md). Direct Sockets reste une proposition : [`adr/0006-direct-sockets-iwa.md`](adr/0006-direct-sockets-iwa.md).
