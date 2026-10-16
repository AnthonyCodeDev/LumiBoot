# Windows 7 — pipeline disque local et streaming HTTP Range

> Statut : **outillage, serveur local ET intégration application livrés**. Le
> groupe Windows 7 sert **deux disques** (fournis par l'opérateur) **in-place**
> par HTTP Range et les démarre par BIOS sous v86, sans copie : **Lite**
> (`images/windows-7-x86/disk.img`, 16 Gio) et **Professionnel SP1 x86**
> (`images/windows-7-pro-sp1-x86/disk.img`, 32 Gio). Aucune image n'est
> distribuée, committée ou copiée dans `public/`.

Ce document décrit le pipeline qui sert les disques Windows 7 installés
(`images/windows-7-x86/disk.img` et `images/windows-7-pro-sp1-x86/disk.img`,
racine du dépôt) au moteur v86 **par requêtes HTTP Range**, sans télécharger les
16/32 Gio et sans jamais modifier ni exposer publiquement les fichiers source.

## 1. Pipeline reproductible (`scripts/prepare-windows7-asset.mjs`)

Outil réutilisable pour Windows 7/XP/Vista/8/10 ou tout autre disque x86 fourni
par l'opérateur :

```bash
node scripts/prepare-windows7-asset.mjs                 # Windows 7 Pro par défaut
node scripts/prepare-windows7-asset.mjs --check         # vérifie sans écrire
node scripts/prepare-windows7-asset.mjs --skip-hash     # taille + mtime documentés
node scripts/prepare-windows7-asset.mjs \
  --source D:\media\winxp.img --ref windows-xp-x86 \
  --display-name "Windows XP x86" --architecture i386
```

Garanties du script :

- la source est ouverte en **lecture seule** ; aucune écriture n'a le chemin
  source pour cible (vérifié : taille et `mtime` de l'image source inchangés) ;
- aucune copie n'est faite par défaut : le manifeste enregistre `source.path` et
  le disque est servi **in-place** ;
- le SHA-256 est calculé **en streaming** (8 Mio/bloc), jamais en RAM ;
- `--skip-hash` documente explicitement taille + `mtime` + méthode (`sha256sum`) ;
- `--resume` réutilise l'empreinte d'un manifeste existant si taille/`mtime`
  concordent ;
- `--copy-to` (optionnel) produit une **copie vérifiée** (`.part` puis `rename`,
  hash recalculé et comparé), refusée si elle viserait la source ou un dossier
  `public/` ;
- sortie par défaut `images/<ref>/` (ignorée par Git), jamais dans le bundle.

Sorties : `images/<ref>/manifest.json` (validé par
`parseLocalDiskManifest`, `packages/vm-assets/src/local-disk.ts`) et
`images/<ref>/provenance.txt`.

### Résultat mesuré sur les disques réels

**Professionnel SP1 x86** (`windows-7-pro-sp1-x86`) :

| Champ | Valeur |
|---|---|
| Source | `images/windows-7-pro-sp1-x86/disk.img` (lecture seule, in-place) |
| Taille | `34359738368` octets (32.000 Gio, exact) |
| `mtimeMs` | `1792161212939` |
| SHA-256 | `ea7a630a3c797d7622c69d6ea17feeb93928efd6914de010a1a7dc787f5c6979` |
| Format | `raw` |
| Mode de boot | `disk-boot`, disque `hda.async = true` |
| Mémoire invitée | `1536` Mio (v86 arrondit à 128 Kio, aucune puissance de deux requise) |
| Binaires moteur | `v86.wasm`, `seabios.bin`, `vgabios.bin` (verrou `scripts/v86-assets.lock.json`) |

**Lite** (`windows-7-x86`) :

| Champ | Valeur |
|---|---|
| Source | `images/windows-7-x86/disk.img` (lecture seule, in-place) |
| Taille | `17179869184` octets (16.000 Gio, exact) |
| `mtimeMs` / SHA-256 | voir `images/windows-7-x86/manifest.json` (généré par le même outil) |
| Format | `raw` |
| Mode de boot | `disk-boot`, disque `hda.async = true` |
| Mémoire invitée | `1024` Mio (v86 arrondit à 128 Kio, aucune puissance de deux requise) |
| Binaires moteur | `v86.wasm`, `seabios.bin`, `vgabios.bin` (verrou `scripts/v86-assets.lock.json`) |

## 2. Middleware de dev multi-ref (`scripts/lib/disk-asset-dev.mjs`)

Au démarrage, le middleware **découvre** tous les disques locaux :

- la racine du dépôt est trouvée par marqueur robuste (`pnpm-workspace.yaml` ou
  `images/` contenant `*/manifest.json`), plus aucune ref codée en dur ;
- chaque `images/<ref>/manifest.json` (`boot.mode === 'disk-boot'`) est validé
  (`ref` conforme `^[a-z0-9-]+$`) ;
- le disque est résolu (`images/<ref>/<servedName>` puis `manifest.source.path`)
  et sa taille vérifiée contre `manifest.disk.size` ;
- les routes `/images/<ref>/<servedName>` (Range) et
  `/images/<ref>/manifest.json` (JSON) sont enregistrées dans une Map ; les
  entrées ignorées (disque absent, taille incohérente…) sont loggées sans
  bloquer le reste.

Toute requête hors Map passe au middleware suivant (`next()`) : le
développement des autres systèmes n'est pas affecté. Les garanties
`206`/`Content-Range`/`Accept-Ranges`/CORS/OPTIONS viennent toutes du serveur
Range testé `scripts/lib/range-server.mjs` (jamais dupliquées).

## 3. Serveur local autonome HTTP 206 (`scripts/serve-windows7-asset.mjs`)

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

### Preuves mesurées (image réelle de 32 Gio)

| Requête | Résultat |
|---|---|
| `Range: bytes=0-0` (sonde v86) | `206`, `Content-Range: bytes 0-0/34359738368`, 1 octet |
| `Range: bytes=0-511` | `206`, 512 octets exacts, signature MBR `55AA` |
| `Range: bytes=34359737856-34359738367` | `206`, 512 octets exacts (accès aléatoire en fin de disque) |
| `Range: bytes=-512` | `206`, `Content-Range: bytes 34359737856-34359738367/34359738368` |
| `Range: bytes=999999999999-` | `416`, `Content-Range: bytes */34359738368` |
| sans jeton (serveur autonome) | `401` |

Le serveur renvoie aussi `Accept-Ranges: bytes`, `Content-Length` exact, un
`OPTIONS` CORS (en-têtes `Range`/`X-Accept-Encoding`) et un multi-range
`multipart/byteranges` (non requis par v86, mais couvert par les tests).

Tests : `tests/range-server.test.ts` (serveur réel sur port éphémère, octets
comparés octet à octet).

## 4. Endpoint local non public — risques

**Rien n'est exposé publiquement par défaut** :

- le middleware de dev ne sert que sur l'origine Vite locale ;
- le serveur autonome écoute sur `127.0.0.1` uniquement ; un `--host` non
  loopback **exige** `--expose` et affiche un avertissement ;
- jeton obligatoire par défaut (`?token=…` ou en-tête `X-Lumiboot-Token`) pour le
  serveur autonome ;
- le disque n'est jamais placé dans `public/`, jamais copié au build, et les
  artefacts générés sont ignorés par Git.

**Risques si un serveur est exposé** :

- **aucun contrôle de licence n'est possible côté HTTP** : quiconque peut
  joindre le port peut télécharger l'intégralité du disque (les requêtes Range
  n'empêchent pas un client de tout récupérer par blocs) ;
- un disque Windows installé contient une licence et des données : l'exposition
  ne doit se faire que sur un réseau totalement maîtrisé, en connaissance de
  cause.

## 5. Intégration application (livrée)

L'intégration est **câblée** pour les **deux variantes** du groupe : les profils
catalogue `windows-7-x86` (Lite, mère) et `windows-7-pro-sp1-x86`
(Professionnel, enfant) sont `disk-boot` + `bundled`, `V86Provider` charge
`ensureLocalDiskManifest()` et monte respectivement
`hda: { url: '/images/windows-7-x86/disk.img', async: true, size }` et
`hda: { url: '/images/windows-7-pro-sp1-x86/disk.img', async: true, size }`
(`acpi` activée), et le middleware Vite sert chaque disque sur la même origine
que l'app. Il n'y a **pas** de blob média en mémoire : les disques sont lus par
plages. Le choix de variante se fait sur la fiche via le dropdown (modèle
`docs/system-variants.md`).

## 6. Isolation cross-origin (COOP/COEP)

- **v86 0.5.471 n'utilise pas `SharedArrayBuffer`** (aucune occurrence dans
  `build/libv86.js`) : `Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` ne sont **pas requis** pour ce moteur ;
- `apps/web/vite.config.ts` n'émet ces en-têtes que si `LUMIBOOT_COOP_COEP=1`
  (désactivé par défaut : un `COEP: require-corp` par défaut casserait les
  ressources cross-origin non marquées CORP) ;
- le serveur d'asset autonome émet `Access-Control-Allow-Origin` et peut servir
  le disque cross-origin depuis un autre port.

## 7. Ce qui est prouvé / non prouvé

- **Prouvé** : manifeste conforme (taille/SHA-256 réels), source non modifiée,
  disques servis in-place, serveur HTTP 206 exact, `hda.async` + `size` corrects
  pour v86, intégration application des **deux variantes**. Le boot réel visuel a
  été **exécuté avec succès** (`VM_E2E_ASSETS=1`, Chromium, port 5200) : les deux
  variantes ont atteint un bureau VGA 2D stable (canvas 800×600, `nonBlackRatio`
  = 1.000, `distinctColors` > 100 sur 3 polls), Professionnel par défaut et Lite
  sélectionnée dans le dropdown.
- **À confirmer par l'opérateur** : le rendu exact du bureau Windows sur sa propre
  machine (le test E2E visuel est fourni ; il est activable localement par
  `VM_E2E_ASSETS=1` mais n'est pas exécuté en CI faute de disques de 16/32 Gio).
