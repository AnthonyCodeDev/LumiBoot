# LumiBoot Network Companion

Serveur local qui fournit l'accès réseau aux OS virtualisés par LumiBoot dans le
navigateur (moteur v86, WebAssembly). Il établit, **sur la machine de
l'utilisateur**, les connexions TCP vers Internet au nom de l'invitée, via un
WebSocket **WISP V1** en écoute **exclusivement locale** (`127.0.0.1:37892` par
défaut).

> Ce programme ne fait **AUCUNE virtualisation** et n'exécute **AUCUNE VM**.
> Il ne sert que de pont réseau local et piloté.

## Architecture

```
apps/network-companion/
├── cmd/lumiboot-network/main.go   # binaire : flags, bannière, console, arrêt gracieux
├── internal/
│   ├── config/       # défauts sûrs, fichier JSON, env LUMIBOOT_COMPANION_*, validation
│   ├── console/      # console interactive : appairage (accepter/refuser), sessions, révocation
│   ├── server/       # HTTP + WebSocket : santé, appairage, /wisp/
│   ├── wisp/         # cadrage V1 (wisp.go) + session (handler.go)
│   ├── auth/         # origines, appairage, tokens de session hachés
│   ├── security/     # politique de destinations après résolution DNS
│   ├── connections/  # suivi des flux, quotas, timeouts, bande passante
│   ├── diagnostics/  # compteurs thread-safe
│   └── platform/     # emplacement du fichier de config par OS
└── tests/            # intégration bout en bout (httptest + écho TCP)
```

Module : `github.com/lumiboot/network-companion` — Go 1.22+. **Aucun
`package.json`** : ce répertoire est purement Go et ignoré par pnpm (seuls les
dossiers avec `package.json` rejoignent le workspace).

## Protocole WISP V1 supporté

Conforme au client embarqué dans v86@0.5.471 (V1 uniquement) :

- paquet = `[uint8 type][uint32 stream_id LE][payload...]` ;
- CONNECT (0x01) : `uint8 stream_type` (1=TCP, 2=UDP) + `uint16 port` LE +
  hostname UTF-8 (sans NUL), stream_id ≥ 1 attribué par le client ;
- DATA (0x02), CONTINUE (0x03, `uint32 buffer_remaining` LE), CLOSE (0x04,
  `uint8 raison`) ; INFO (0x05, V2) **ignoré** ;
- **CONTINUE de stream 0 envoyé immédiatement après le handshake** (fenêtre
  initiale = `initialBufferPackets`, 32 par défaut) — sans lui, v86 bloque tout
  envoi ;
- raisons : client `0x02` volontaire / `0x03` erreur ; serveur `0x41` infos
  invalides, `0x42` hôte injoignable, `0x43` timeout connexion, `0x44` refusée,
  `0x47` timeout transfert, `0x48` destination bloquée, `0x49` quota atteint.
  EOF TCP propre côté distant → CLOSE `0x02` ; timeout de transfert → `0x47` ;
- **TCP uniquement** : v86 ne demande que du TCP ; tout `stream_type` ≠ 1 est
  refusé par CLOSE `0x41`. L'UDP est donc documenté non supporté (côté client
  actuel), sans bloquer le reste ;
- un seul écrivain WebSocket (goroutine + canal) ; lectures TCP découpées à
  `maxDataChunk` (128 Kio) ; CONTINUE renvoyé tous les `initialBufferPackets`
  reçus ; lectures limitées (`SetReadLimit`).

## Modèle de sécurité

1. **Écoute loopback exclusive** : toute adresse non-loopback (y compris `:port`
   vide = toutes interfaces) est refusée sauf `allowNonLoopback: true` explicite.
2. **Token de session en query string** (`/wisp/?token=...`) : v86 n'envoie ni
   en-tête ni sous-protocole WebSocket, donc l'URL fournie par LumiBoot au
   provider porte le secret. Token = 32 octets aléatoires base64url, stocké
   **haché (SHA-256)**, TTL 24 h, **lié à l'origine**, usage vérifié en temps
   constant (`crypto/subtle`). Jamais de secret en dur ni en fichier public.
3. **Origin strictement vérifiée** (match exact normalisé) sur `/wisp/` et les
   endpoints sensibles — sans être à elle seule une authentification.
4. **Validation des destinations APRÈS DNS** (`security`) : loopback, link-local,
   privés (10/8, 172.16/12, 192.168/16, fc00::/7), 0.0.0.0/8, multicast,
   broadcast, 240/4 et **endpoints de métadonnées cloud**
   (169.254.169.254, 100.100.100.200, 169.254.170.2, fd00:ec2::254,
   metadata.google.internal) refusés (`0x48`). **Anti DNS-rebinding/TOCTOU** :
   si une seule IP résolue est interdite, tout est refusé, et le dial utilise
   **l'IP validée, jamais le hostname**. `allowPrivateNetworks: true` autorise
   privé/loopback mais **jamais** les métadonnées. Port 0 refusé (`0x41`).
5. **Quotas** : `maxConnections` (64) et `maxConnectionsPerSession` (16),
   refus `0x49` ; timeouts connexion/inactivité/transfert ; limite de bande
   passante optionnelle (token bucket, 0 = illimité) ; balayage des flux
   inactifs.
6. **CORS strict** : origine reflétée uniquement si autorisée, jamais `*` ;
   en-têtes `X-Content-Type-Options`, `X-Frame-Options: DENY`,
   `Referrer-Policy`, CSP restrictive.
7. **Console interactive** (terminal) : à l'apparition d'une demande
   d'appairage, approuver/refuser en tapant `y`/`N` ; commandes `list`/`status`,
   `approve`, `deny`, `revoke <id|all>`, `quit`. Plus aucune page web d'admin ni
   ouverture de navigateur. Corps JSON bornés à 64 Kio.

## Flux d'appairage

1. LumiBoot (origine autorisée) appelle `POST /api/pair/request` → reçoit
   `{pairingId, userCode, expiresAt}` (TTL 10 min) ;
2. la console du compagnon affiche la demande (origine, code, expiration) et
   invite à décider : taper `y` (approbation) ou une autre touche (refus) — ou
   `approve <id|code>` / `deny <id|code>` ;
3. LumiBoot échange (`POST /api/pair/exchange`, même origine) → reçoit
   `{token, expiresAt}` (usage unique) et compose
   `ws://127.0.0.1:37892/wisp/?token=...` pour v86 ;
4. `GET /api/pair/status?id=...` suit l'état ; `POST /api/session/revoke`
   révoque par possession du token, ou `revoke <id|all>` depuis la console.

Autres routes : `GET /health` → `{status, version, wispVersion: 1, uptimeSeconds,
activeConnections, counters}`.

## Build / exécution / tests

```sh
cd apps/network-companion
go mod tidy
go build ./...
go test ./...
go vet ./...
gofmt -l .
```

Lancer :

```sh
go run ./cmd/lumiboot-network [--config PATH] [--listen 127.0.0.1:37892] [--version]
```

Configuration : fichier JSON (défaut :
`<UserConfigDir>/LumiBoot/Network Companion/config.json`) + surcharge
`LUMIBOOT_COMPANION_*` (`LISTEN_ADDR`, `ALLOWED_ORIGINS` séparées par virgules,
`MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_SESSION`, `CONNECT_TIMEOUT`,
`IDLE_TIMEOUT`, `DATA_TIMEOUT`, `INITIAL_BUFFER_PACKETS`, `MAX_DATA_CHUNK`,
`ALLOW_PRIVATE_NETWORKS`, `ALLOW_NON_LOOPBACK`, `BANDWIDTH_LIMIT_BPS`,
`PAIRING_TTL`, `SESSION_TOKEN_TTL` ; durées Go `"10s"` ou secondes).

## Plateformes

Windows / Linux / macOS, amd64 + arm64 (stdlib + `gorilla/websocket`). Aucun
droit admin demandé.

## Limitations connues

- **UDP non supporté** par le client v86 actuel (refus propre `0x41`) ;
- invité derrière NAT virtuel : seul le TCP sortant est ponté (pas d'écoute
  entrante, pas d'ICMP) ;
- le token en query peut apparaître dans des journaux : TTL courte possible via
  `SESSION_TOKEN_TTL`, révocation à tout moment ;
- les origines dev loopback doivent être listées explicitement (ports
  courants pré-remplis : 3000, 4173, 5173, 5200, 8080).

## Licences des dépendances

- `github.com/gorilla/websocket` v1.5.3 — BSD-2-Clause (maintenue, standard de
  fait) ;
- le reste : bibliothèque standard Go (licence BSD de Go).
