# Sécurité

## Invariants

- Les VM s'exécutent dans le navigateur ; aucune commande serveur ne démarre une VM.
- Les variables `VITE_*` et `apps/web/public/lumiboot.config.json` sont publiques : aucun secret ne doit y être placé.
- Les médias propriétaires et gros disques restent hors Git et hors bundle Vite.
- Les états `ready`, `running` et `connected` exigent une preuve technique, pas une simple configuration.
- La télémétrie ne doit jamais capturer le terminal ou le contenu de l'invité.

## Réseau

- `browser-fetch` respecte CORS et n'offre pas de TCP brut.
- `user-relay` doit viser un relais WISP administré ou approuvé par l'utilisateur.
- Le proxy local écoute sur loopback, vérifie origine et token, bloque les réseaux privés et les métadonnées cloud après DNS, puis applique quotas et délais.
- `allowPrivateNetworks` et `allowNonLoopback` réduisent l'isolation ; ne les activer qu'après analyse explicite.
- Un token WISP apparaît dans l'URL à cause des limites de v86 0.5.471 : limiter sa durée et permettre sa révocation.

## Déploiement

Les en-têtes Nginx sont dans `infra/nginx/security-headers.conf`. COOP/COEP reste optionnel via `LUMIBOOT_COOP_COEP=1` car v86 0.5.471 n'utilise pas `SharedArrayBuffer`.

Signaler les vulnérabilités en privé aux mainteneurs avant toute publication.
