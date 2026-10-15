# ADR 0007 — Compagnon réseau local natif (« LumiBoot Network Companion »)

- **Statut :** accepté
- **Date :** 2026-10-15
- **Contexte :** Avec `v86@0.5.471`, les modes réseau existants sont limités : `browser-fetch`
  ne transporte que le HTTP (port 80, CORS appliqué, pas de HTTPS donc pas d'`apt`), et
  `user-relay` exige un serveur WISP distant administré par l'utilisateur (voir
  [`0005-network-universal.md`](0005-network-universal.md)). Il manque un chemin « 1-clic »
  qui donne à l'invité un vrai accès TCP sortant via la connexion de l'utilisateur, sans
  backend LumiBoot ni relais public, tout en restant compatible avec l'ADR 0001 (local
  exclusif) et l'ADR 0003 (aucun proxy/relais distant opéré par LumiBoot).

## Décision

Un **compagnon natif Go multiplateforme** (`apps/network-companion/`, module
`github.com/lumiboot/network-companion`, entrée `./cmd/lumiboot-network`) fournit un
**serveur WISP V1 local** en écoute **exclusivement loopback** (`127.0.0.1:37892` par
défaut). Il **n'exécute aucune VM** : c'est uniquement un pont réseau piloté, sur la
machine de l'utilisateur, qui établit les connexions TCP sortantes au nom de l'invité.

- **Protocole WISP V1** (`COMPANION_WISP_VERSION = 1`, côté frontend comme côté compagnon) :
  cadrage `[type:u8][stream_id:u32 LE][payload]`, CONNECT (0x01, TCP uniquement), DATA,
  CONTINUE (fenêtre initiale envoyée dès le handshake, exigée par v86), CLOSE ; INFO (0x05,
  V2) ignoré. UDP refusé proprement : le client v86 actuel ne demande que du TCP.
- **Appairage explicite + Origin + token en query** : v86 0.5.471 n'envoie **ni
  sous-protocole ni en-tête** WebSocket, donc le secret transite par l'URL
  (`/wisp/?token=…`). Le frontend demande un appairage (`POST /api/pair/request`), **l'utilisateur
  approuve depuis la page d'admin locale** (jeton d'admin généré au démarrage), puis le
  frontend échange l'approbation contre un token à usage unique lié à l'origine (stocké
  haché SHA-256, TTL 24 h, révocable). L'`Origin` est vérifiée strictement sans être à elle
  seule une authentification.
- **Destinations sensibles bloquées après résolution DNS** : loopback, link-local, réseaux
  privés, 0.0.0.0/8, multicast/broadcast, 240/4 et **endpoints de métadonnées cloud** sont
  refusés ; le dial utilise **l'IP validée, jamais le hostname** (anti DNS-rebinding/TOCTOU).
  Quotas de connexions, timeouts et CORS strict complètent le modèle.
- **Distribution via GitHub Releases + manifeste** : le workflow
  `.github/workflows/network-companion.yml` compile 6 cibles (windows/linux/darwin ×
  amd64/arm64, `CGO_ENABLED=0`), fait tourner un **smoke natif par OS** (le binaire est
  réellement exécuté, pas seulement compilé), puis publie sur tag `network-v*` une
  **préversion non signée** avec `SHA256SUMS` et `manifest.json` (`version`, `wispVersion`,
  `generatedAt`, `platforms`, tailles et SHA-256 réels). La signature (Authenticode) et la
  signature + notarisation Apple sont **optionnelles** (secrets uniquement, jamais de
  certificat dans le dépôt) et requises avant toute publication stable.
- Côté frontend, le mode `local-companion` (relais WISP local sur loopback) expose les mêmes
  capacités de transport que `user-relay` (`https = true`, `cors = false`), mais
  `fullInternet` reste **`false` par défaut** : seule une sonde à l'exécution peut le prouver.

## Alternatives écartées

- **Relais public (opéré par LumiBoot ou tiers inconnu)** : introduirait un backend distant et
  ferait du relais l'IP de sortie de tous les utilisateurs — contraire aux ADR 0001 et 0003,
  et risque confidentialité/confiance inacceptable par défaut.
- **Isolated Web App / Direct Sockets pour l'instant** : donnerait du TCP/UDP brut sans
  compagnon, mais **non disponible aujourd'hui** (onglet ordinaire sans API brute, voir
  [`0006-direct-sockets-iwa.md`](0006-direct-sockets-iwa.md)). Réévaluer quand le support
  existera ; le compagnon reste utile en attendant.
- **Réécriture du protocole** : inventer un transport maison au lieu de WISP casserait la
  compatibilité avec le client WISP embarqué dans v86 0.5.471 sans apporter de sécurité
  supplémentaire. WISP V1 est donc conservé tel quel, avec refus explicite de ce que le
  client actuel ne supporte pas (UDP).

## Conséquences

- L'utilisateur installe un binaire natif (Windows/macOS/Linux, amd64/arm64) — étape
  supplémentaire assumée, documentée dans [`../network-companion.md`](../network-companion.md) ;
  **plateformes mobiles non supportées** (sandboxing, services d'arrière-plan).
- La confiance se déplace vers la machine locale : token en query visible dans les journaux
  locaux (TTL courte et révocation possibles), écoute loopback seule, appairage révocable.
- Limitations honnêtes conservées : **UDP non supporté par le client v86 actuel**, ICMP non
  garanti, pas d'écoute entrante côté invité (NAT virtuel, TCP sortant seul).
- Compatibilité frontend↔compagnon verrouillée sur **WISP V1** ; tout changement de version
  de protocole exigera un nouvel ADR et une montée de version conjointe.
- Sans signature, les artefacts restent des **préversions non signées** (SmartScreen/Gatekeeper
  avertiront ou bloqueront) ; la promotion en stable attend la signature/notarisation.
