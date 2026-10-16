# Windows 7 Lite x86 sous v86 (disque RAW local)

## Résumé honnête

Windows 7 **Lite** (x86) est **sélectionnable** dans la bibliothèque et
**démarre directement** : le disque RAW de la codebase
(`images/windows-7-x86/disk.img`, 16 Gio, **ignoré par Git**) est monté en
disque dur (`hda`) et démarré par **BIOS** sous v86. Il n'y a **aucun import**
de média, **aucune ISO** et **aucun contrôle de licence** dans l'interface : la
fiche ne présente qu'un bouton **« Lancer une session »**.

Le profil est désormais **`validated: true`** : le démarrage BIOS réel du disque
local (preuve `disk-boot`, voir plus bas) vaut validation, l'état catalogue est
donc **`ready`** (« Disponible »). Le lancement reste autorisé par le disque
local existant (cf. `getLaunchReadiness`, mode `disk-boot`).

## Où vit le disque

| Élément | Chemin | Suivi Git |
|---|---|---|
| Disque RAW (16 Gio) | `images/windows-7-x86/disk.img` | **non** (`.gitignore`) |
| Manifeste du disque | `images/windows-7-x86/manifest.json` | **non** |
| Provenance / empreinte | `images/windows-7-x86/provenance.txt` | **non** |
| Outil de préparation | `scripts/prepare-windows7-asset.mjs` | oui |
| Serveur Range autonome | `scripts/serve-windows7-asset.mjs` | oui |
| Middleware Range de dev | `scripts/lib/disk-asset-dev.mjs` | oui |

Le disque source d'origine (`C:\Users\antho\Desktop\Windows7.img`) n'est
**jamais modifié** : la copie vérifiée par SHA-256 a été faite par l'outil
(`--copy-to`), qui refuse d'écrire sur la source ou dans `public/`.

### Préparer / vérifier le disque

```sh
# Copie vérifiée depuis le Desktop (jamais committée) :
node scripts/prepare-windows7-asset.mjs \
  --source "C:\Users\antho\Desktop\Windows7.img" \
  --out images/windows-7-x86 \
  --copy-to images/windows-7-x86/disk.img

# Vérifier le manifeste (taille, mtime, SHA-256 en streaming) :
pnpm assets:windows7:check
```

Le disque fait exactement **17 179 869 184 octets** (16 Gio). Il n'est
**jamais** copié dans `apps/web/public/` ni dans le bundle Vite : un fichier de
16 Gio ne doit pas entrer dans le build.

## Servir le disque en développement (HTTP Range 206)

v86 lit `hda` par requêtes HTTP `Range` (et sonde la taille via
`Range: bytes=0-0`). Le plugin Vite `lumiboot-windows-disk-asset`
(`apps/web/vite.config.ts` → `scripts/lib/disk-asset-dev.mjs`) sert, **sur la
même origine que l'app** :

- `/images/windows-7-x86/disk.img` → `206 Partial Content` + `Content-Range` +
  `Accept-Ranges: bytes` (lecture par plages, aucune mise en mémoire complète) ;
- `/images/windows-7-x86/manifest.json` → le manifeste disque local.

Sans ce middleware (ou si le disque est absent), la session échouerait avec
`IMAGE_MISSING` : le développement des autres systèmes n'est pas affecté.

En production, le disque local **n'est pas servi** : ce middleware n'existe
qu'en dev. Une variante autonome existe pour un test hors Vite :

```sh
pnpm assets:windows7:serve   # http://127.0.0.1:37893 (loopback + jeton)
```

## Choix technique : le moteur et le matériel

v86 est le seul moteur navigateur **x86 32 bits réellement intégré**. C'est un
émulateur PC complet : il démarre l'image disque par **BIOS** (MBR), sans noyau
Linux. Le profil `windows-7-x86` (`packages/catalog/src/profiles.ts`) :

- `engineId: 'v86'`, `executionMode: 'browser'`, `bootDevice: 'disk'` ;
- mémoire invitée **1024 Mio** — `memory_size` de v86 **exige une puissance de
  deux** (`assertPowerOfTwoMiB`) ; 1024 est un plancher sûr pour la famille
  Vista+ (512 Mio minimum documenté) ;
- matériel émulé : disque **IDE**, **VGA**, PS/2, NIC **ne2k**, **ACPI activée**
  (requise par Vista+ ; voir `docs/windows-nt.md` de v86) ;
- preuve de démarrage `mode: 'disk-boot'` : `running` n'est émis qu'après une
  **lecture réelle du disque** (`ide-read-end`, canal 0), jamais simulée.

### Média : jamais en cdrom

Le disque est **toujours** monté en disque dur (`hda`), lu en `async` par HTTP
Range. Il n'est **jamais** monté en `cdrom` (ce n'est pas une ISO). v86 lit la
base en lecture seule ; les écritures invitées restent dans le tampon mémoire de
l'instance et disparaissent à l'arrêt de la session (aucune persistance
revendiquée).

## Séparation des responsabilités

| Couche | Rôle | Fichiers |
|---|---|---|
| Catalogue | `mediaStrategy: 'bundled'` (défaut), `imageRef: 'windows-7-x86'`, `validated: true`, état `ready` | `packages/catalog/src/{images,profiles,systems}.ts` |
| Manifeste disque | Schéma + chargement (`ensureLocalDiskManifest`) | `packages/vm-assets/src/local-disk.ts` |
| Exécution | Démarrage BIOS du disque local (`hda.async`), états de session | `packages/provider-v86/src/V86Provider.ts`, `packages/vm-core/*` |
| UI | Fiche : bouton « Lancer une session » seul, plus d'import | `apps/web/src/pages/SystemPage.tsx`, `apps/web/src/lib/launch.ts` |
| Dev | Service HTTP Range du disque | `apps/web/vite.config.ts`, `scripts/lib/disk-asset-dev.mjs` |

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
> vaut validation et rend le système `ready` ; elle n'atteste pas que le bureau
> Windows est pleinement opérationnel.

## Limites techniques connues (documentées honnêtement)

- **Taille du disque (16 Gio).** Le disque n'est jamais chargé entièrement : v86
  le lit par plages (`206`). La mémoire de l'invité (1024 Mio) limite le tampon
  interne, mais un disque de cette taille, non amorçable ou mal formé, ne
  produira aucun `running`.
- **Performance.** Émulation logicielle : démarrage de plusieurs minutes, pas
  d'accélération matérielle.
- **Pas de persistance.** Les écritures invitées sont perdues à l'arrêt.
- **Preuve limitée au disque.** La validation repose sur la lecture réelle du
  disque (`disk-boot`) : le bureau Windows pleinement fonctionnel n'est pas
  attesté par un marqueur LumiBoot.

## Licences

Le disque est un actif **local de la codebase**, ignoré par Git et **non
distribué** par LumiBoot. Aucune ISO, clé ou image Windows n'est publiée,
téléchargée ou committée. Voir [`LICENSES.md`](LICENSES.md).
