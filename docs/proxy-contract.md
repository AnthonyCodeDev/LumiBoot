# Contrat du proxy réseau local

Base par défaut : `http://127.0.0.1:37892`. Toutes les réponses HTTP sont en JSON, sauf l'upgrade WebSocket. Les routes sensibles exigent une origine autorisée.

## Endpoints

| Méthode et route | Succès | Rôle |
|---|---|---|
| `GET /health` | `200` | état, version, `wispVersion`, uptime et compteurs |
| `POST /api/pair/request` | `201` | crée `{pairingId,userCode,expiresAt}` |
| `GET /api/pair/status?id=…` | `200` | renvoie `pending`, `approved` ou `denied` |
| `POST /api/pair/exchange` | `200` | échange `{pairingId}` contre `{token,expiresAt}` |
| `GET /api/session/verify?token=…` | `200` | preuve authentifiée `{ok:true,expiresAt}` |
| `POST /api/session/revoke` | `200` | révoque `{token}` et ferme les flux associés |
| `GET /wisp/?token=…` | `101` | upgrade WISP V1 |

Corps JSON inconnus ou mal formés : `400`. Origine refusée ou échange impossible : `403`. Token invalide sur `verify` : `401`. Ressource expirée/inconnue : `404`. Trop de demandes : `429`.

## Appairage

- Une demande expire après 10 minutes par défaut.
- L'échange exige la même origine et une approbation console.
- L'identifiant d'appairage est à usage unique.
- Le token contient 32 octets aléatoires encodés en base64url, n'est retourné qu'une fois et est stocké haché.
- Le token est lié à l'origine et expire après 24 heures par défaut.

Le frontend ne doit afficher `connected` qu'après `GET /api/session/verify` réussi. Un `/health` valide laisse l'état à `pairing-required`.

## WISP V1

Trame : `[type:u8][stream_id:u32 little-endian][payload]`.

| Type | Code | Support |
|---|---:|---|
| CONNECT | `0x01` | TCP uniquement |
| DATA | `0x02` | oui |
| CONTINUE | `0x03` | oui ; fenêtre initiale envoyée au handshake |
| CLOSE | `0x04` | oui |
| INFO V2 | `0x05` | ignoré |

UDP est fermé avec `0x41`. Le proxy annonce `wispVersion: 1`; le frontend refuse toute autre version (`PROXY_WISP_VERSION`).

## Persistance web

Le frontend peut conserver le token dans `localStorage` sous `lumiboot.proxy.session`, avec l'URL du proxy et son expiration. Il doit le supprimer après expiration ou révocation.
