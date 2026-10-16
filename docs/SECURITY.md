# Sécurité

## Invariants

- Les VM s'exécutent dans le navigateur ; aucune commande serveur ne démarre une VM.
- Les variables `VITE_*` et `apps/web/public/lumiboot.config.json` sont publiques : aucun secret ne doit y être placé.
- Les médias propriétaires et gros disques restent hors Git et hors bundle Vite.
- Les états `ready`, `running` et `connected` exigent une preuve technique, pas une simple configuration.
- La télémétrie ne doit jamais capturer le terminal ou le contenu de l'invité.

## Menace XSS

L'application traite des données d'origine non fiable (contenu invité, réponses réseau). Une
XSS réussie peut lire tout secret accessible au contexte JS de l'origine LumiBoot.

- **Bearer d'appairage** : le jeton de session du proxy réseau local n'est persisté que dans
  `sessionStorage` (`lumiboot.proxy.session`). Il ne survit pas à la fermeture de l'onglet et
  n'est pas partagé entre onglets. L'ancienne clé `localStorage` d'une version antérieure est
  purgée sans migration. Le jeton n'est jamais lu depuis le stockage pour l'exécution : seule la
  copie mémoire (`getProxyRuntimeCredentials`) est utilisée, et uniquement à l'état authentifié.
- **URL WISP** : le token figure en query (`…/wisp/?token=…`) à cause des limites de v86
  0.5.471. Aucune URL WISP ni aucun token ne doit être journalisé (`console.*`, télémétrie,
  rapports d'erreur). Un garde-fou de test échoue si un log du front référence `token`, `wisp`,
  `relay_url` ou `proxyToken`.
- **Sourcemaps** : désactivées en production par défaut. Une sourcemap publique expose le code
  source original et facilite l'exploitation d'une XSS. Activation explicite uniquement
  (`LUMIBOOT_SOURCEMAP=1`, ou `hidden` pour un `.map` non publié sur le webroot statique).
- **CSP** : `connect-src` reste une allow-list d'origines exactes (jamais `*` ni un schéma
  global) ; voir `infra/nginx/security-headers.conf`.

## Réseau

- `browser-fetch` respecte CORS et n'offre pas de TCP brut.
- `user-relay` doit viser un relais WISP administré ou approuvé par l'utilisateur.
- Le proxy local écoute sur loopback, vérifie origine et token, bloque les réseaux privés et les métadonnées cloud après DNS, puis applique quotas et délais.
- `allowPrivateNetworks` et `allowNonLoopback` réduisent l'isolation ; ne les activer qu'après analyse explicite.
- Un token WISP apparaît dans l'URL à cause des limites de v86 0.5.471 : limiter sa durée et permettre sa révocation.

### Allowlist d'origines DEV / PROD (proxy réseau)

L'allowlist d'origines du proxy réseau local est **séparée par environnement** :

- **Production (défaut)** : seules les origines LumiBoot (`https://lumiboot.app`,
  `https://www.lumiboot.app`). Aucune origine `localhost` générique n'est acceptée.
- **Développement** : `LUMIBOOT_PROXY_ENV=development` élargit l'allowlist aux boucles locales
  du monorepo (5173, 5200, 3000, 4173, 8080). À n'utiliser que sur un poste de dev.
- **Appairage local explicite** : si l'UI est réellement servie depuis un poste (déploiement
  local), activer `allowLocalOrigins` (`LUMIBOOT_PROXY_ALLOW_LOCAL_ORIGINS=true`) ou lister les
  origines exactes. Toute origine loopback en production sans cet opt-in est refusée à la
  validation.

La révocation (`POST /api/session/revoke`) est la déconnexion : elle supprime la session côté
proxy et purge immédiatement le stockage local.

## Déploiement

Les en-têtes Nginx sont dans `infra/nginx/security-headers.conf`. COOP/COEP reste optionnel via `LUMIBOOT_COOP_COEP=1` car v86 0.5.471 n'utilise pas `SharedArrayBuffer`.

`infra/nginx/site.conf` applique les règles suivantes :

- `/downloads/` est **strictement statique** : aucun fallback SPA (un fichier absent renvoie un
  vrai 404, jamais `index.html`), `Accept-Ranges` autorisé pour reprendre un téléchargement,
  compression désactivée pour ne pas casser les réponses 206. `/downloads/manifest.json` est
  servi en `application/json` (`no-store`).
- Le WASM de v86 est servi avec `application/wasm` ; aucun fallback SPA sous `/v86/`.
- `/images/` sert les disques des distributions **libres** (Debian) en HTTP Range, sans index ni
  fallback SPA. Les médias système **propriétaires** (Windows…) et les médias utilisateur sont
  interdits dans le webroot public : un bloc Nginx les refuse explicitement en 404, et le
  garde-fou CI `tests/webroot-assets.test.ts` échoue si un tel média est copié dans
  `apps/web/public/` ou `apps/web/dist/`.

## Export source / bundle release

- L'export **source** (`python export_project_zip.py`) n'écrit jamais de faux binaire : un
  artefact trop volumineux est **omis** (jamais remplacé par un texte `.img`/`.exe`) et décrit
  dans `EXPORT-MANIFEST.json` (chemin, taille, SHA-256). Le vrai dossier `images/` et les assets
  ne sont jamais modifiés ni supprimés.
- Le **bundle release** (`--profile release`) est distinct : il n'embarque que le build web et
  les téléchargements, et refuse les médias non libres via un garde-fou.

Signaler les vulnérabilités en privé aux mainteneurs avant toute publication.
