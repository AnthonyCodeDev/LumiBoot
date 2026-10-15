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
administrateur demandé. Téléchargez l'artefact de votre plateforme depuis le dossier
`apps/web/public/downloads/` du site (voir
[Manifeste et intégrité](#manifeste-de-téléchargement-et-intégrité)).

| Plateforme | Fichier | Installation / lancement |
|---|---|---|
| Windows x64 | `LumiBoot-Network-windows-amd64.exe` | Double-cliquez (SmartScreen avertira tant que le binaire n'est pas signé : « Informations complémentaires » → « Exécuter quand même », préversion uniquement). |
| Windows ARM64 | `LumiBoot-Network-windows-arm64.exe` | Idem (Surface / machines ARM). |
| Linux x64 | `LumiBoot-Network-linux-amd64.tar.gz` | `tar -xzf … && ./lumiboot-network` |
| Linux ARM64 | `LumiBoot-Network-linux-arm64.tar.gz` | Idem (Raspberry Pi 64 bits, etc.). |
| macOS universel (Intel + Apple Silicon) | `LumiBoot-Network-macos-universal.tar.gz` | `tar -xzf … && ./lumiboot-network` ; au premier lancement non signé, Gatekeeper bloque : clic droit → Ouvrir, ou `xattr -d com.apple.quarantine lumiboot-network`. Binaire universel assemblé avec `lipo -create` (V1 : tar.gz uniquement, pas encore d'app `.app` signée/notarisée). |

Options utiles : `--config CHEMIN` (fichier JSON), `--listen 127.0.0.1:37892` (doit rester
loopback sauf `allowNonLoopback: true` explicite), `--version`. La configuration peut aussi
passer par fichier JSON et variables `LUMIBOOT_COMPANION_*` (voir
`apps/network-companion/README.md`). Aucun navigateur n'est ouvert : tout se pilote depuis la
console du terminal.

## Flux d'appairage (pas à pas)

1. **Téléchargez et lancez** le compagnon (tableau ci-dessus). Il affiche une bannière et une
   **console interactive** dans le terminal ; tapez `help` pour la liste des commandes.
2. **Revenez sur LumiBoot** et choisissez le réseau **« Companion »** (`local-companion`).
   LumiBoot envoie une **demande d'appairage** au compagnon (`POST /api/pair/request`) et
   affiche un code utilisateur.
3. **Autorisez** la demande **depuis la console du compagnon** : à l'apparition, la console
   affiche l'origine, le code et l'expiration, puis demande `Approuver ? [y/N]`. Tapez `y`
   (ou `oui`) pour approuver, toute autre touche refuse (TTL 10 min). Vous pouvez aussi
   utiliser `approve <id|code>` / `deny <id|code>`. Refusez toute demande que vous n'avez pas
   initiée.
4. **Connectez** : LumiBoot échange l'approbation contre un **token de session à usage
   unique** (`POST /api/pair/exchange`) et compose `ws://127.0.0.1:37892/wisp/?token=…`
   pour v86.
5. **WISP établi** : l'invité obtient DHCP/DNS et son trafic TCP sort par votre connexion.
   Vérifiez depuis l'invité : `getent hosts deb.debian.org`, `curl -I https://deb.debian.org/`.

Pour révoquer : depuis la console du compagnon, `revoke <id|all>` (les sessions actives sont
listées à l'apparition et via `list`/`status`), ou `POST /api/session/revoke` par possession
du token. Changer de mode réseau exige un **redémarrage** de la session (profil fixé avant
démarrage).

**Le jeton de session est persisté** (clé `localStorage` `lumiboot.companion.session`) :
l'appairage **survit à un rechargement de page** (F5) sans repasser par
`pairing-required`. À la relecture, le jeton n'est réutilisé que si l'URL du compagnon
correspond **et** que sa date d'expiration n'est pas dépassée ; sinon il est supprimé. Le
jeton est également **supprimé à la révocation**. Compromis sécurité : le jeton reste
**loopback uniquement**, **lié à l'origine** qui sert LumiBoot, à **TTL** et **révocable**,
ce qui limite le risque XSS à cette seule origine (voir [Sécurité](#sécurité)).

## Sélection automatique

Aucun choix manuel n'est nécessaire pour profiter du compagnon : à la création de la
session, LumiBoot sélectionne automatiquement le mode effectif **pour toute VM**. Si le
compagnon est **appairé et connecté** (jeton de session présent), le mode `local-companion`
est utilisé automatiquement. Sinon, le **mode de base** configuré (`browser-fetch` par
défaut) s'applique ; un mode de base `local-companion` sans compagnon retombe sur
`browser-fetch`. Les modes explicitement choisis `offline` et `user-relay` restent
**respectés** (le compagnon ne les remplace jamais). Le mode étant figé avant le démarrage
de l'émulateur, tout changement de mode exige un **redémarrage de la session**.

## Sécurité

- **Loopback seul** : toute adresse d'écoute non-loopback est refusée sauf
  `allowNonLoopback: true` explicite. Le compagnon n'est jamais exposé au LAN/Internet.
- **Appairage explicite** : sans approbation locale, aucun token n'est délivré ; `Origin`
  strictement vérifiée (match exact) sur `/wisp/` et endpoints sensibles.
- **Révocation** : sessions révocables à tout moment (TTL 24 h par défaut, réglable via
  `SESSION_TOKEN_TTL`).
- **Persistance du jeton** : pour survivre au rechargement de page (F5), le jeton de
  session est stocké dans `localStorage` (`lumiboot.companion.session`). Compromis assumé :
  le jeton est **loopback uniquement**, **lié à l'origine** LumiBoot, à **TTL** (expiration
  revérifiée à la relecture, puis nettoyage) et **révocable** ; il est **supprimé à la
  révocation ou à l'expiration**. Le risque XSS est ainsi circonscrit à l'origine qui sert
  LumiBoot.
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

Le manifeste consommé par le site est `apps/web/public/downloads/manifest.json`. Il est
**généré par la CI** (job `release`) et livré **dans le ZIP de release** à côté des binaires
et de `SHA256SUMS` ; le mainteneur n'a plus qu'à décompresser ce ZIP dans
`apps/web/public/downloads/` (voir [Procédure de publication](#procédure-de-publication)).
Chaque entrée référence un fichier local :

```json
{
  "version": "1.0.0",
  "wispVersion": 1,
  "generatedAt": "2026-10-15T12:00:00Z",
  "platforms": {
    "windows-x64":   { "file": "LumiBoot-Network-windows-amd64.exe", "url": "/downloads/LumiBoot-Network-windows-amd64.exe", "size": 1234567, "sha256": "…", "published": true },
    "windows-arm64": { "file": "LumiBoot-Network-windows-arm64.exe", "url": "/downloads/LumiBoot-Network-windows-arm64.exe", "size": 1234567, "sha256": "…", "published": true },
    "linux-x64":     { "file": "LumiBoot-Network-linux-amd64.tar.gz", "url": "/downloads/LumiBoot-Network-linux-amd64.tar.gz", "size": 1234567, "sha256": "…", "published": true },
    "linux-arm64":   { "file": "LumiBoot-Network-linux-arm64.tar.gz", "url": "/downloads/LumiBoot-Network-linux-arm64.tar.gz", "size": 1234567, "sha256": "…", "published": true },
    "macos":         { "file": "LumiBoot-Network-macos-universal.tar.gz", "url": "/downloads/LumiBoot-Network-macos-universal.tar.gz", "size": 1234567, "sha256": "…", "published": true, "signed": false, "notarized": false }
  }
}
```

Les `url` sont **relatives** au site (`/downloads/<fichier>`), pas des liens GitHub. Les
champs `size` et `sha256` sont **calculés automatiquement par la CI** sur les binaires réels
du ZIP (mêmes valeurs que `SHA256SUMS`). `macos` désigne le binaire **universel**
`LumiBoot-Network-macos-universal.tar.gz` (Intel + Apple Silicon, assemblé avec
`lipo -create` par le job `package-macos`) ; la V1 fournit ce binaire universel en tar.gz
(pas encore d'app `.app` signée/notarisée). Les archives mono-architecture
`LumiBoot-Network-darwin-amd64.tar.gz` / `LumiBoot-Network-darwin-arm64.tar.gz` restent
produites par `build` comme artefacts du run (pour diagnostic) mais ne sont **pas**
référencées par le manifeste. Vérifiez l'intégrité avant d'exécuter :

```powershell
# Windows (PowerShell) : calculer le SHA-256 du fichier téléchargé
Get-FileHash .\LumiBoot-Network-windows-amd64.exe -Algorithm SHA256
```

```sh
# Linux / macOS
sha256sum LumiBoot-Network-linux-amd64.tar.gz
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

**Publication automatique (Release GitHub, repo privé)** : à chaque release, la CI crée
elle-même une **Release GitHub dans ce dépôt privé** (via `GITHUB_TOKEN`, aucun PAT ni dépôt
public) contenant **un seul fichier ZIP** : `LumiBoot-Network-companion-<version>.zip`. Ce
ZIP regroupe **tous les binaires** + `manifest.json` + `SHA256SUMS` **à sa racine** ; le
`manifest.json` pointe déjà vers `/downloads/<fichier>`. Le mainteneur n'a donc qu'à
télécharger et décompresser ce ZIP.

1. **Déclencher** le workflow `.github/workflows/network-companion.yml` :
   - manuellement (onglet **Actions → Network Companion → Run workflow**) : **aucune saisie
     requise** — la version est calculée automatiquement (voir ci-dessous) ;
   - ou en poussant un tag `network-vX.Y.Z`
     (`git tag network-vX.Y.Z && git push origin network-vX.Y.Z`) → le job `release` crée la
     Release pour ce tag.
2. **Versionnement automatique** (job `prepare`, toujours exécuté) : la CI liste les tags
   `network-v*` existants et, s'il n'y en a **aucun**, publie **`1.0.0`** ; sinon elle
   **incrémente le patch** du dernier (`1.0.0` → `1.0.1` → `1.0.2` … ; le tri est
   sémantique via `sort -V`, donc `1.0.9` → `1.0.10`). Le tag créé est `network-v<version>`.
   L'entrée `version` du *Run workflow* reste une **surcharge optionnelle** : si vous la
   remplissez, elle prime sur l'auto-incrément.
3. Le workflow exécute **test → build (6 cibles) + smoke natif (4 OS) + package macOS
   universel (`lipo -create`, job `package-macos`)**, puis le job **`release`**
   (`needs: [prepare, build, package-macos, smoke]`, `if: needs.prepare.outputs.release == 'true'`) :
   - télécharge tous les artefacts dans `dist/` ;
   - calcule `SHA256SUMS` (`sha256sum LumiBoot-Network-*> SHA256SUMS`) et génère
     `manifest.json` (les 5 plateformes, `url` = `/downloads/<fichier>`, `size`/`sha256`
     réels, `published: true`, `macos` en `signed:false` / `notarized:false`) ;
   - produit le ZIP unique `LumiBoot-Network-companion-<version>.zip` ;
   - crée la **Release GitHub** (`gh release create`, notes générées + encart d'utilisation).
4. **Récupération en un clic** : ouvrir la page **Releases** du dépôt et télécharger
   `LumiBoot-Network-companion-<version>.zip`.
5. **Décompression** : extraire le contenu de ce ZIP **dans
   `apps/web/public/downloads/`** (les binaires + `manifest.json` + `SHA256SUMS` se
   retrouvent à la racine de ce dossier). Aucune édition manuelle du manifeste n'est requise,
   puisqu'il est déjà généré avec les bonnes `url` `/downloads/...`.
6. **Signature optionnelle** (jobs `sign-windows` / `sign-macos`) : désactivée par défaut.
   Elle ne s'exécute que si la **variable** de dépôt `ENABLE_SIGNING` vaut `true` (et sur un
   tag `network-v*`), puis requiert les secrets correspondants
   (`WINDOWS_CERT_PFX_BASE64` + `WINDOWS_CERT_PASSWORD`, ou `APPLE_CERT_P12_BASE64` +
   `APPLE_CERT_PASSWORD` + `APPLE_TEAM_ID` + `APPLE_ID` + `APPLE_APP_PASSWORD`). Cette
   signature n'est **pas câblée** au flux de publication : le ZIP est publié **non signé /
   non notarisé** (`ENABLE_SIGNING` non câblée). Windows (SmartScreen) et macOS (Gatekeeper)
   afficheront un avertissement ; ne jamais marquer « stable » un binaire non signé.
