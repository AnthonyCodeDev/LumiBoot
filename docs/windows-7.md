# Windows 7 sous v86 — groupe de variantes (Lite 16 Gio & Professionnel SP1 x86 32 Gio)

## Résumé honnête

Windows 7 est présenté comme un **groupe de variantes** dans la bibliothèque :
une seule carte « Windows 7 » ouvre la fiche de la mère neutre
(`windows-7-x86`), et un **dropdown** permet de choisir la variante à lancer.
Le modèle est **identique à celui de Debian** (voir `docs/system-variants.md`) :
le libellé du dropdown vaut « nom de base + spécificité » — « Windows 7
Professionnel » et « Windows 7 Lite » — et le choix de variante **ne change pas**
le contenu de la fiche, seulement le disque lancé.

| Variante | Profil | Disque RAW | Mémoire invitée | Rôle |
|---|---|---|---|---|
| **Professionnel** SP1 x86 | `windows-7-pro-sp1-x86` (enfant, `variantGroupId: 'windows-7-x86'`, `variantOrder: 1`) | `images/windows-7-pro-sp1-x86/disk.img` (**32 Gio**) | 1536 Mio | **meilleure variante / défaut** — `validated: true` |
| **Lite** x86 | `windows-7-x86` (mère/ancre, **pas** de `variantGroupId`, `variantOrder: 2`) | `images/windows-7-x86/disk.img` (**16 Gio**) | 1024 Mio | variante allégée — `validated: true` |

Les deux disques sont **sélectionnables** et **démarrent directement** : chaque
disque RAW **déjà installé** (fourni par l'opérateur, racine du dépôt) est monté
en disque dur (`hda`) et démarré par **BIOS** sous v86. Il n'y a **aucun import**
de média, **aucune ISO** et **aucun contrôle de licence** dans l'interface : la
fiche ne présente qu'un dropdown de variante et un bouton **« Lancer une
session »**.

Les **deux** variantes sont **`validated: true`** : le démarrage BIOS réel du
disque local (preuve `disk-boot`, voir plus bas) vaut validation, et le boot
bureau a été prouvé pour chacune par le test E2E visuel sous Chromium
(`tests/e2e/windows7-desktop.spec.ts`, `VM_E2E_ASSETS=1`). L'état catalogue des
deux est donc **`ready`** (« Disponible ») ; le lancement est en outre autorisé
par le disque local existant (cf. `getLaunchReadiness`, mode `disk-boot`).

## Où vit le disque (servi IN-PLACE, jamais copié)

Les deux disques du groupe vivent à la racine du dépôt, chacun dans son dossier
`images/<ref>/`, et sont servis **in-place** (jamais copiés) :

| Élément | Lite (`windows-7-x86`) | Professionnel (`windows-7-pro-sp1-x86`) | Suivi Git |
|---|---|---|---|
| Disque RAW | `images/windows-7-x86/disk.img` (**16 Gio**, 17 179 869 184 octets) | `images/windows-7-pro-sp1-x86/disk.img` (**32 Gio**, 34 359 738 368 octets) | **ignoré par Git** |
| URL servie | `/images/windows-7-x86/disk.img` | `/images/windows-7-pro-sp1-x86/disk.img` | n/a |
| Manifeste du disque | `images/windows-7-x86/manifest.json` | `images/windows-7-pro-sp1-x86/manifest.json` | **non** |
| Provenance / empreinte | `images/windows-7-x86/provenance.txt` | `images/windows-7-pro-sp1-x86/provenance.txt` | **non** |
| Outil de préparation | `scripts/prepare-windows7-asset.mjs` | `scripts/prepare-windows7-asset.mjs` | oui |
| Serveur Range autonome | `scripts/serve-windows7-asset.mjs` | `scripts/serve-windows7-asset.mjs` | oui |
| Middleware Range de dev | `scripts/lib/disk-asset-dev.mjs` | `scripts/lib/disk-asset-dev.mjs` | oui |

Chaque disque source est **ouvert en LECTURE SEULE** et n'est **jamais** copié,
modifié, tronqué ni écrasé. Le middleware dev résout chaque fichier par son
`manifest.source.path` et le sert **in-place** : aucun octet n'est dupliqué dans
le dépôt, `public/` ni le bundle Vite (les seules écritures visant la source sont
explicitement refusées).

### Où placer le disque (opérateur/serveur)

- **Défaut (recommandé)** : déposer chaque RAW dans son dossier
  `images/<ref>/disk.img` (racine du dépôt, ignoré par Git) — Lite
  (`images/windows-7-x86/disk.img`, 16 Gio) et Professionnel
  (`images/windows-7-pro-sp1-x86/disk.img`, 32 Gio). Si le fichier est déjà sur
  le **même volume** que le dépôt, le simple déplacement est instantané (pas de
  copie de 16/32 Gio).
- **Alternative serveur** : pointer `WINDOWS7_IMG` (variable d'environnement) ou
  l'option `--source` vers un chemin absolu, par exemple un volume de données
  serveur (`WINDOWS7_IMG=E:\data\Windows7Pro.img`). Aucun chemin propre à une
  machine n'est committé.
- **Après tout déplacement**, régénérer le manifeste de la référence concernée
  (`node scripts/prepare-windows7-asset.mjs --force --resume`) : `--resume`
  réutilise le SHA-256 existant tant que la taille et le `mtime` sont inchangés
  (cas d'un déplacement sur le même volume), sinon il est recalculé en
  streaming.

### Préparer / vérifier le manifeste (sans copie)

```sh
# Variante Professionnel (32 Gio) — SHA-256 streaming, lecture seule, aucune copie :
node scripts/prepare-windows7-asset.mjs \
  --source "images/windows-7-pro-sp1-x86/disk.img" \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 \
  --memory-mib 1536 \
  --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86

# Variante Lite (16 Gio) — même outil, autre référence :
node scripts/prepare-windows7-asset.mjs \
  --source "images/windows-7-x86/disk.img" \
  --ref windows-7-x86 \
  --display-name "Windows 7 Lite x86" \
  --architecture i386 \
  --memory-mib 1024 \
  --vga-mib 16 \
  --out images/windows-7-x86

# Vérifier un manifeste (taille, mtime, SHA-256 en streaming) :
pnpm assets:windows7:check
```

Le disque Professionnel fait exactement **34 359 738 368 octets** (32.000 Gio) et
le disque Lite **17 179 869 184 octets** (16.000 Gio). Aucun n'est **jamais**
copié dans `apps/web/public/` ni dans le bundle Vite : des fichiers de 16/32 Gio
ne doivent pas entrer dans le build. `--copy-to` (copie vérifiée) existe toujours
pour d'autres usages mais n'est pas nécessaire ici.

## Servir le disque en développement (HTTP Range 206)

v86 lit `hda` par requêtes HTTP `Range` (et sonde la taille via
`Range: bytes=0-0`). Le plugin Vite `lumiboot-windows-disk-asset`
(`apps/web/vite.config.ts` → `scripts/lib/disk-asset-dev.mjs`) **découvre
génériquement** tous les disques locaux sous `images/*/manifest.json` et sert,
**sur la même origine que l'app** :

- `/images/<ref>/<servedName>` → `206 Partial Content` + `Content-Range` +
  `Accept-Ranges: bytes` (lecture par plages, aucune mise en mémoire complète) ;
- `/images/<ref>/manifest.json` → le manifeste disque local.

Pour ce groupe, **deux références sont servies** :
`/images/windows-7-pro-sp1-x86/disk.img` (Professionnel) et
`/images/windows-7-x86/disk.img` (Lite), plus leurs `manifest.json` respectifs.

La découverte est mutualisée (Windows XP/Vista/7/8/10, tout disque `disk-boot`)
et n'est **plus** codée en dur sur une référence. Sans ce middleware (ou si le
disque est absent), la session échouerait avec `IMAGE_MISSING` : le
développement des autres systèmes n'est pas affecté.

En production, le disque local **n'est pas servi** : ce middleware n'existe
qu'en dev. Une variante autonome existe pour un test hors Vite :

```sh
pnpm assets:windows7:serve   # http://127.0.0.1:37893 (loopback + jeton)
```

## Choix technique : le moteur et le matériel

v86 est le seul moteur navigateur **x86 32 bits réellement intégré**. C'est un
émulateur PC complet : il démarre l'image disque par **BIOS** (MBR), sans noyau
Linux. Les deux profils du groupe (`packages/catalog/src/profiles.ts`) partagent
le même moteur et le même matériel :

- `engineId: 'v86'`, `executionMode: 'browser'`, `bootDevice: 'disk'` ;
- mémoire invitée **1536 Mio** (Professionnel) / **1024 Mio** (Lite) — v86
  arrondit `create_memory` à un multiple de 128 Kio et **n'exige PAS une
  puissance de deux** : 1536 (valeur de l'invité installé sous QEMU) est valide
  et accepté. La validation du provider est un entier `> 0` dont la taille en
  octets tient dans un entier signé 32 bits (`assertSupportedMemoryMiB`) ;
- matériel émulé : disque **IDE**, **VGA**, PS/2, NIC **ne2k**, **ACPI activée**
  (requise par Vista+ ; voir `docs/windows-nt.md` de v86) ;
- preuve de démarrage `mode: 'disk-boot'` : `running` n'est émis qu'après une
  **lecture réelle du disque** (`ide-read-end`, canal 0), jamais simulée. Chaque
  variante porte son propre marqueur documentaire :
  `LUMIBOOT_DISK_BOOT:windows-7-pro-sp1-x86` et
  `LUMIBOOT_DISK_BOOT:windows-7-x86`.

Le profil de la **mère** est `windows-7-x86` (id neutre, `displayName: 'Windows
7'`, `variantName: 'Lite'`) ; l'**enfant** `windows-7-pro-sp1-x86` porte
`variantGroupId: 'windows-7-x86'`, `variantName: 'Professionnel'` et
`variantOrder: 1` (meilleure variante, lancée par défaut).

### Média : jamais en cdrom, immuable, écritures par session

Le disque est **toujours** monté en disque dur (`hda`), lu en `async` par HTTP
Range. Il n'est **jamais** monté en `cdrom` (ce n'est pas une ISO). v86 lit la
base en lecture seule ; les écritures invitées restent dans le **tampon mémoire
de l'instance** et disparaissent à l'arrêt de la session (aucune persistance
revendiquée, la base disque n'est jamais modifiée). C'est vrai pour les deux
variantes (Lite et Professionnel).

## Séparation des responsabilités

| Couche | Rôle | Fichiers |
|---|---|---|
| Catalogue | Groupe : mère Lite (`windows-7-x86`, `variantOrder: 2`, `validated: true`) + enfant Professionnel (`windows-7-pro-sp1-x86`, `variantGroupId: 'windows-7-x86'`, `variantOrder: 1`, `validated: true`) ; `mediaStrategy: 'bundled'` et `imageRef` par variante | `packages/catalog/src/{images,profiles,systems}.ts` |
| Manifeste disque | Schéma + chargement (`ensureLocalDiskManifest`) | `packages/vm-assets/src/local-disk.ts` |
| Exécution | Démarrage BIOS du disque local (`hda.async`), états de session | `packages/provider-v86/src/V86Provider.ts`, `packages/vm-core/*` |
| UI | Fiche : dropdown de variante + bouton « Lancer une session » seul, plus d'import | `apps/web/src/pages/SystemPage.tsx`, `apps/web/src/lib/launch.ts` |
| Dev | Service HTTP Range des disques locaux (multi-ref) | `apps/web/vite.config.ts`, `scripts/lib/disk-asset-dev.mjs` |

## Cycle de vie d'une session

États normalisés : `idle → preparing → downloading → booting → running →
stopping → stopped` (+ `error`).

- `downloading` correspond au chargement du disque par HTTP Range ;
- `running` n'est émis qu'après une **lecture réelle du disque dur** par
  l'invité (`ide-read-end`, canal 0). Un disque non amorçable ne produit jamais
  cet événement : aucun `running` n'est simulé ;
- si le manifeste ou le disque est introuvable, le provider échoue avec
  `IMAGE_MISSING` et l'interface n'affiche jamais de fausse progression.

> **Portée de la preuve `disk-boot`.** Contrairement à Debian (marqueur
> `LUMIBOOT_GUEST_READY` émis par l'OS réellement démarré), Windows n'émet aucun
> marqueur LumiBoot. La preuve `disk-boot` atteste que **l'amorce invitée
> s'exécute** (le BIOS lit bien le disque). C'est cette lecture disque réelle qui
> vaut validation et rend la variante `ready` : c'est le cas des **deux**
> variantes **Professionnel** et **Lite** (`validated: true`). La preuve du bureau
> Windows pleinement fonctionnel est en outre apportée par le test E2E visuel
> (`tests/e2e/windows7-desktop.spec.ts`, canvas VGA 2D réel), qui couvre les deux
> variantes (Professionnel par défaut et Lite sélectionnée dans le dropdown) et a
> été exécuté avec succès (`VM_E2E_ASSETS=1`).

## Mutualiser le pipeline pour Windows XP/Vista/8/10

Le même pipeline sert n'importe quel disque x86 local sans code spécifique :

1. générer un manifeste avec `scripts/prepare-windows7-asset.mjs` (`--source`,
   `--ref`, `--display-name`, `--architecture`, `--memory-mib`) ;
2. le middleware dev découvre automatiquement `images/<ref>/manifest.json` ;
3. déclarer l'image (`images.ts`) et le profil (`profiles.ts`) avec
   `readiness: diskBootReadiness('<ref>')` et `hardwareProfile` adapté.

Aucune copie, aucun ajout Git, aucun `public/`.

## Limites techniques connues (documentées honnêtement)

- **Taille des disques (16/32 Gio).** Aucun disque n'est jamais chargé
  entièrement : v86 les lit par plages (`206`). La mémoire de l'invité
  (1024/1536 Mio) limite le tampon interne, mais un disque non amorçable ou mal
  formé ne produira aucun `running`.
- **Performance.** Émulation logicielle : démarrage de plusieurs minutes, pas
  d'accélération matérielle.
- **Pas de persistance.** Les écritures invitées sont perdues à l'arrêt.
- **Preuve limitée au disque.** La validation catalogue repose sur la lecture
  réelle du disque (`disk-boot`) ; un boot réel de bout en bout est couvert par
  le test E2E visuel Chromium, activé par `VM_E2E_ASSETS=1`.

## Licences

Les disques sont des actifs **locaux de l'opérateur**, servis in-place, ignorés
par Git et **non distribués** par LumiBoot. Aucune ISO, clé ou image Windows n'est
publiée, téléchargée ou committée. Voir [`LICENSES.md`](LICENSES.md).
