# Windows 7 — pipeline disque local et streaming HTTP Range

> Statut : **outillage et serveur local livrés et mesurés** ; **intégration à
> l'interface non câblée**. Aucune image n'est distribuée, committée ou copiée
> dans `public/`. Aucun boot Windows réel n'est annoncé comme validé.

Ce document décrit le pipeline mis en place pour servir un disque Windows 7
(fourni localement par l'utilisateur, ici `C:\Users\antho\Desktop\Windows7.img`)
au moteur v86 **par requêtes HTTP Range**, sans télécharger les 16 Gio et sans
jamais modifier ni exposer publiquement le fichier source.

## 1. Pipeline reproductible (`scripts/prepare-windows7-asset.mjs`)

Outil réutilisable pour Windows 7/XP/Vista ou tout autre disque x86 fourni par
l'utilisateur :

```bash
node scripts/prepare-windows7-asset.mjs                 # Windows 7 par défaut
node scripts/prepare-windows7-asset.mjs --check         # vérifie sans écrire
node scripts/prepare-windows7-asset.mjs --skip-hash     # taille + mtime documentés
node scripts/prepare-windows7-asset.mjs \
  --source D:\media\winxp.img --ref windows-xp-x86 \
  --display-name "Windows XP x86" --architecture i386
```

Garanties du script :

- la source est ouverte en **lecture seule** ; aucune écriture n'a le chemin
  source pour cible (vérifié : taille et `mtime` de `Windows7.img` inchangés) ;
- le SHA-256 est calculé **en streaming** (8 Mio/bloc), jamais en RAM ;
- `--skip-hash` documente explicitement taille + `mtime` + méthode (`sha256sum`) ;
- `--resume` réutilise l'empreinte d'un manifeste existant si taille/`mtime`
  concordent ;
- `--copy-to` produit une **copie vérifiée** (`.part` puis `rename`, hash
  recalculé et comparé), refusée si elle viserait la source ou un dossier
  `public/` ;
- sortie par défaut `images/<ref>/` (ignorée par Git), jamais dans le bundle.

Sorties : `images/<ref>/manifest.json` (validé par
`parseLocalDiskManifest`, `packages/vm-assets/src/local-disk.ts`) et
`images/<ref>/provenance.txt`.

### Résultat mesuré sur le disque réel

| Champ | Valeur |
|---|---|
| Source | `C:\Users\antho\Desktop\Windows7.img` |
| Taille | `17179869184` octets (16.000 Gio, exact) |
| `mtimeMs` | `1792155200430` (2026-10-16T12:53:20.430Z) |
| SHA-256 | `967aae93ac019217d340c1de791b702f4af80ec2443ea1f244c4d68123477bc2` |
| Format | `raw` |
| Mode de boot | `disk-boot`, disque `hda.async = true` |
| Binaires moteur | `v86.wasm`, `seabios.bin`, `vgabios.bin` (verrou `scripts/v86-assets.lock.json`) |

## 2. Serveur local HTTP 206 (`scripts/serve-windows7-asset.mjs`)

```bash
node scripts/serve-windows7-asset.mjs                 # 127.0.0.1:37893 + jeton aléatoire
node scripts/serve-windows7-asset.mjs --no-token      # loopback seulement
node scripts/serve-windows7-asset.mjs --port 37893
```

Le serveur sert sur **une seule origine** : le disque, le manifeste, et les
binaires du moteur v86. Le code est réutilisable et testé
(`scripts/lib/range-server.mjs`).

### Exigences v86 (vérifiées dans `v86@0.5.471/build/libv86.js`)

- v86 charge `hda.async` par **XMLHttpRequest** avec `Range: bytes=start-end`
  et `X-Accept-Encoding: identity` ;
- **si le serveur répond 200 à une requête Range, v86 abandonne** : toute plage
  valide DOIT renvoyer `206` ;
- v86 sonde la taille via `Range: bytes=0-0` et lit `Content-Range`
  (`/\/(\d+)\s*$/`) : l'en-tête doit toujours être présent ;
- **aucune compression** ne doit être appliquée aux réponses par plages.

### Preuves mesurées (image réelle de 16 Gio)

| Requête | Résultat |
|---|---|
| `Range: bytes=0-0` (sonde v86) | `206`, `Content-Range: bytes 0-0/17179869184`, 1 octet |
| `Range: bytes=0-511` | `206`, 512 octets exacts, signature MBR `55AA` |
| `Range: bytes=17179868672-17179869183` | `206`, 512 octets exacts (accès aléatoire en fin de disque) |
| `Range: bytes=-512` | `206`, `Content-Range: bytes 17179868672-17179869183/17179869184` |
| `Range: bytes=999999999999-` | `416`, `Content-Range: bytes */17179869184` |
| sans jeton | `401` |

Le serveur renvoie aussi `Accept-Ranges: bytes`, `Content-Length` exact, un
`OPTIONS` CORS (en-têtes `Range`/`X-Accept-Encoding`) et un multi-range
`multipart/byteranges` (non requis par v86, mais couvert par les tests).

Tests : `tests/range-server.test.ts` (21 cas, serveur réel sur port
éphémère, octets comparés octet à octet).

## 3. Endpoint local non public — risques

**Rien n'est exposé publiquement par défaut** :

- écoute sur `127.0.0.1` uniquement ; un `--host` non loopback **exige**
  `--expose` et affiche un avertissement ;
- jeton obligatoire par défaut (`?token=…` ou en-tête `X-Lumiboot-Token`) ;
- le disque n'est jamais placé dans `public/`, jamais copié au build, et les
  artefacts générés sont ignorés par Git.

**Risques si le serveur est exposé** :

- **aucun contrôle de licence n'est possible côté HTTP** : quiconque peut
  joindre le port peut télécharger l'intégralité du disque (les requêtes Range
  n'empêchent pas un client de tout récupérer par blocs) ;
- un disque Windows installé contient une licence et des données : le
  `--expose` ne doit être utilisé que sur un réseau totalement maîtrisé, en
  connaissance de cause.

## 4. Isolation cross-origin (COOP/COEP)

- **v86 0.5.471 n'utilise pas `SharedArrayBuffer`** (aucune occurrence dans
  `build/libv86.js`) : `Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` ne sont **pas requis** pour ce moteur ;
- `apps/web/vite.config.ts` n'émettaient ces en-têtes : une option a été
  ajoutée, **désactivée par défaut**, activable par `LUMIBOOT_COOP_COEP=1`
  (un `COEP: require-corp` par défaut casserait les ressources cross-origin non
  marquées CORP, par ex. Google Fonts) ;
- le serveur d'asset local émet `Access-Control-Allow-Origin` et peut servir le
  disque cross-origin depuis le serveur de dev Vite ; si une isolation est un
  jour activée, il faudra `Cross-Origin-Resource-Policy: cross-origin`.

## 5. Intégration application — prérequis restants

Aujourd'hui, l'import de média (`apps/web/src/features/sessions/sessions.store.ts`
→ `resolveUserMedia`) crée une **URL `blob:`** en mémoire, ce qui peut charger
tout le fichier (limite déjà documentée dans `docs/windows-7.md`). Le serveur
Range local est la brique manquante, mais son câblage n'est **pas encore fait** :

1. exposer l'URL locale (`http://127.0.0.1:<port>/images/windows-7-x86/disk.img`)
   comme média de session plutôt qu'un blob (nouvelle source de config) ;
2. propager le jeton dans **toutes** les URL v86 (disque **et** binaires moteur,
   `wasm_path`/`bios`/`vga_bios`), donc une option provider dédiée ;
3. ajouter l'origine locale exacte dans `connect-src` de la CSP
   (`infra/nginx/security-headers.conf`) — jamais un wildcard ;
4. décider du contrôle de licence : le serveur local ne peut pas le faire, ce
   doit rester un choix explicite de l'opérateur.

Tant que ces points ne sont pas faits, la fonctionnalité reste **prérequis
incomplet** et aucun « Disponible » n'est affiché.

## 6. Ce qui est prouvé / non prouvé

- **Prouvé** : manifeste conforme (taille/SHA-256 réels), source non modifiée,
  serveur HTTP 206 exact (en-tête MBR, fin de disque, suffixe, multi-range),
  `hda.async` + `size` corrects pour v86.
- **Non prouvé** : un boot Windows réel de bout en bout dans v86, et
  l'intégration navigateur du serveur Range (points ci-dessus).
