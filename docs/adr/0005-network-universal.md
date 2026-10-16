# ADR 0005 — Réseau commun

- Statut : accepté
- Date : 2026-10-14

## Décision

`@lumiboot/vm-network` décrit les profils, capacités, diagnostics et cycles de vie réseau indépendamment du moteur. `provider-v86` traduit ensuite le profil en `net_device`.

| Mode | État | Transport |
|---|---|---|
| `offline` | disponible | aucune NIC |
| `browser-fetch` | disponible | backend Fetch de v86 ; HTTP 80, CORS, pas de HTTPS |
| `local-proxy` | disponible | WISP V1 vers le proxy local loopback |
| `user-relay` | disponible | relais WISP fourni par l'utilisateur |
| `local-network` | prévu | réseau virtuel entre invités, non implémenté |

Trois niveaux ne doivent pas être confondus : profil configuré, capacité théorique, connectivité vérifiée par une sonde réelle. `fullInternet` reste donc `false` par défaut pour tous les modes.

## Conséquences

- Le profil est fixé avant le démarrage ; tout changement recrée la session.
- Aucun relais public n'est fourni.
- Les compteurs de trafic ne prouvent pas la connectivité.
- Les limites et la configuration sont détaillées dans [`../network.md`](../network.md).
