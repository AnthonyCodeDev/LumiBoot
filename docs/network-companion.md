# Compagnon réseau local — LumiBoot Network Companion

Le **LumiBoot Network Companion** (`apps/network-companion/`) est un petit serveur natif qui
donne à la VM invitée un vrai accès TCP sortant via la connexion de l'utilisateur, sans
relais distant. Il expose un **serveur WISP V1 local** sur `127.0.0.1:37892` (loopback
uniquement), auquel LumiBoot relie l'invité en mode `local-companion`.

> Ce programme ne fait **AUCUNE virtualisation** et n'exécute **AUCUNE VM**. Il ne sert que
> de pont réseau local et piloté. Décision structurante :
> [`adr/0007-network-companion.md`](adr/0007-network-companion.md).

## Installation par plateforme

Prérequis : Windows 10+/11, macOS 13+, ou Linux (amd64 ou arm64). Aucun droit
administrateur demandé. Téléchargez l'artefact de votre plateforme depuis la page
**Releases** GitHub (tag `network-vX.Y.Z`), puis vérifiez son intégrité (voir
[Manifeste et intégrité](#manifeste-de-téléchargement-et-intégrité)).

| Plateforme | Fichier | Installation / lancement |
|---|---|---|
| Windows x64 | `LumiBoot-Network-windows-amd64.exe` | Double-cliquez (SmartScreen avertira tant que le binaire n'est pas signé : « Informations complémentaires » → « Exécuter quand même », préversion uniquement). |
| Windows ARM64 | `LumiBoot-Network-windows-arm64.exe` | Idem (Surface / machines ARM). |
| Linux x64 | `LumiBoot-Network-linux-amd64.tar.gz` | `tar -xzf … && ./lumiboot-network` |
| Linux ARM64 | `LumiBoot-Network-linux-arm64.tar.gz` | Idem (Raspberry Pi 64 bits, etc.). |
| macOS universel (Intel + Apple Silicon) | `LumiBoot-Network-macos-universal.tar.gz` | `tar -xzf … && ./lumiboot-network` ; au premier lancement non signé, Gatekeeper bloque : clic droit → Ouvrir, ou `xattr -d com.apple.quarantine lumiboot-network`. Binaire universel assemblé avec `lipo -create` (V1 : tar.gz uniquement, pas encore d'app `.app` signée/notarisée). |

Options utiles : `--config CHEMIN` (fichier JSON), `--listen 127.0.0.1:37892` (doit rester
loopback sauf `allowNonLoopback: true` explicite), `--no-browser` (ne pas ouvrir la page
d'admin), `--version`. La configuration peut aussi passer par fichier JSON et variables
`LUMIBOOT_COMPANION_*` (voir `apps/network-companion/README.md`).

## Flux d'appairage (pas à pas)

1. **Téléchargez et lancez** le compagnon (tableau ci-dessus). Une page d'admin locale
   s'ouvre (`http://127.0.0.1:37892/`) ; le **jeton d'admin** généré au démarrage s'affiche
   dans la console — gardez-le.
2. **Revenez sur LumiBoot** et choisissez le réseau **« Companion »** (`local-companion`).
   LumiBoot envoie une **demande d'appairage** au compagnon (`POST /api/pair/request`) et
   affiche un code utilisateur.
3. **Autorisez** la demande depuis la page d'admin locale (bouton Approuver, jeton d'admin ;
   TTL 10 min). Refusez toute demande que vous n'avez pas initiée.
4. **Connectez** : LumiBoot échange l'approbation contre un **token de session à usage
   unique** (`POST /api/pair/exchange`) et compose `ws://127.0.0.1:37892/wisp/?token=…`
   pour v86.
5. **WISP établi** : l'invité obtient DHCP/DNS et son trafic TCP sort par votre connexion.
   Vérifiez depuis l'invité : `getent hosts deb.debian.org`, `curl -I https://deb.debian.org/`.

Pour révoquer : page d'admin → Révoquer la session, ou `POST /api/session/revoke`. Changer
de mode réseau exige un **redémarrage** de la session (profil fixé avant démarrage).

## Sécurité

- **Loopback seul** : toute adresse d'écoute non-loopback est refusée sauf
  `allowNonLoopback: true` explicite. Le compagnon n'est jamais exposé au LAN/Internet.
- **Appairage explicite** : sans approbation locale, aucun token n'est délivré ; `Origin`
  strictement vérifiée (match exact) sur `/wisp/` et endpoints sensibles.
- **Révocation** : sessions révocables à tout moment (TTL 24 h par défaut, réglable via
  `SESSION_TOKEN_TTL`).
- **Blocage après résolution DNS** : loopback, link-local, réseaux privés (10/8,
  172.16/12, 192.168/16, fc00::/7), 0.0.0.0/8, multicast/broadcast, 240/4 et **endpoints de
  métadonnées cloud** (169.254.169.254, 100.100.100.200, …) refusés ; le dial utilise l'IP
  validée, jamais le hostname (anti DNS-rebinding). `allowPrivateNetworks: true` autorise
  le privé/loopback mais **jamais** les métadonnées.
- **Quotas** : 64 connexions max (16 par session), timeouts connexion/inactivité/transfert,
  limite de bande passante optionnelle.
- **Jamais de secret** dans `lumiboot.config.json` (public) ni de certificat dans le dépôt
  (signature uniquement via secrets CI).

## Manifeste de téléchargement et intégrité

Chaque release `network-vX.Y.Z` publie un **`manifest.json`** et un **`SHA256SUMS`** :

```json
{
  "version": "1.0.0",
  "wispVersion": 1,
  "generatedAt": "2026-10-15T12:00:00Z",
  "platforms": {
    "windows-x64":   { "file": "…", "url": "…", "size": 1234567, "sha256": "…", "published": true },
    "windows-arm64": { "file": "…", "url": "…", "size": 1234567, "sha256": "…", "published": true },
    "linux-x64":     { "file": "…", "url": "…", "size": 1234567, "sha256": "…", "published": true },
    "linux-arm64":   { "file": "…", "url": "…", "size": 1234567, "sha256": "…", "published": true },
    "macos":         { "file": "…", "url": "…", "size": 1234567, "sha256": "…", "published": true, "signed": false, "notarized": false }
  }
}
```

Les `url` pointent vers `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`
(tailles et SHA-256 **réels**, calculés au moment de la release — aucun lien fictif).
`macos` désigne le binaire **universel** `LumiBoot-Network-macos-universal.tar.gz`
(Intel + Apple Silicon, assemblé avec `lipo -create` par le job `package-macos`) ;
la V1 fournit ce binaire universel en tar.gz (pas encore d'app `.app`
signée/notarisée). Les archives mono-architecture `LumiBoot-Network-darwin-*.tar.gz`
restent publiées en assets pour diagnostic (checksums dans `SHA256SUMS`) mais ne sont
pas référencées par le manifeste. Vérifiez avant d'exécuter :

```powershell
# Windows (PowerShell) : comparer avec SHA256SUMS
Get-FileHash .\LumiBoot-Network-windows-amd64.exe -Algorithm SHA256
```

```sh
# Linux / macOS
grep "$(sha256sum <fichier> | cut -d' ' -f1)" SHA256SUMS
```

## Versions compatibles frontend ↔ compagnon

- **Protocole WISP : V1 uniquement**, des deux côtés (`COMPANION_WISP_VERSION = 1` dans
  `packages/vm-network/src/companion.ts`, `WispVersion = 1` dans
  `apps/network-companion/internal/server/`). Le compagnon ignore les paquets INFO (V2).
- La page LumiBoot vérifie `/health` (`{version, wispVersion: 1, …}`) avant l'appairage ; en
  cas de `wispVersion` inattendue, l'état est `incompatible` — mettez à jour le compagnon
  (ou le frontend) vers une version parlant WISP V1.
- Règle : tout changement de version de protocole exigera une montée de version conjointe
  (nouvel ADR).

## Limitations réelles

- **UDP non supporté par le client v86 actuel** (refus propre `0x41`) ; seul le TCP sortant
  est ponté — pas d'écoute entrante côté invité, **ICMP non garanti** (`ping` peut échouer).
- **Token en query visible dans les journaux locaux** (console, historique) : conséquence
  assumée du client v86 0.5.471 (ni sous-protocole ni en-tête) — TTL courte possible et
  révocation à tout moment.
- **Plateformes mobiles NON supportées** (sandboxing iOS/Android, pas de service
  d'arrière-plan fiable).
- `fullInternet` reste **`false` par défaut** même en `local-companion` : seule une
  vérification à l'exécution (sondes depuis l'invité) prouve la connectivité.

## Procédure de publication

1. Fusionner sur `main`, puis tagger : `git tag network-vX.Y.Z && git push origin network-vX.Y.Z`.
2. Le workflow `.github/workflows/network-companion.yml` exécute **test → build (6 cibles) +
   smoke natif (4 OS) + package macOS universel (`lipo -create`, job `package-macos`) → release**. La release créée est une **préversion non signée**
   (`--prerelease`, notes générées + avertissement non signé/notarisé).
3. **Signature** (jobs `sign-windows` / `sign-macos`, ignorés sans secrets) : renseigner
   `WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD`, ou `APPLE_CERT_P12_BASE64` +
   `APPLE_CERT_PASSWORD` + `APPLE_TEAM_ID` + `APPLE_ID` + `APPLE_APP_PASSWORD`. Les
   artefacts signés sont publiés comme artefacts de workflow ; la promotion en release
   **stable** (pièces jointes signées, `signed`/`notarized: true` dans le manifeste) est
   **manuelle** et ne doit jamais marquer « stable » un binaire non signé.
