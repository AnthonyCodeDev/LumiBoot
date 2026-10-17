# Windows 10 sous v86

Windows 10 **32 bits** suit le **même pipeline disque RAW local** que Windows 7 :
un disque RAW installé, préparé par l'opérateur, amorcé sous v86 (même moteur,
même readiness `disk-boot`). Le profil catalogue correspondant porte
`validated: true`, donc sa disponibilité est `ready`, comme Windows 7.

Windows 10 **64 bits** est **bloqué** : le catalogue l'associe au moteur
`wasm-x86_64`, qui n'est pas intégré (`integrated: false`), et v86 n'émule que
le x86 32 bits. Aucun moteur navigateur x86-64 n'existe dans ce dépôt.

Aucune ISO, image, clé ou lien de téléchargement Windows n'est fourni, téléchargé
ni redistribué par LumiBoot. La licence Windows et le média sont sous la
responsabilité de l'opérateur.

## Prérequis

Partez soit d'un disque Windows 10 **32 bits déjà installé**, soit d'une **ISO
x86** à installer vous-même sous QEMU (voir
[« Installer Windows 10 x86 depuis une ISO (QEMU) »](#installer-windows-10-x86-depuis-une-iso-qemu)).

- Un disque déjà **installé** de Windows 10 **32 bits**, amorçable en **BIOS/MBR**
  (une installation UEFI/GPT ne démarre pas sous v86).
- Ce disque doit être **vôtre** : installation personnelle réalisée depuis votre
  propre média sous QEMU/VirtualBox, puis convertie en RAW (voir ci-dessous).
- Une licence Windows valide pour la machine invitée.
- Node.js 20+ et pnpm 9.14.2, comme le reste du dépôt.

> **Sécurité** : Windows 10 n'est plus maintenu (fin du support standard en 2025).
> N'utilisez pas une session Windows 10 connectée à Internet. Le disque est
> monté en lecture seule et les écritures invitées restent en mémoire : une
> session Windows 10 doit rester **hors ligne** (`offline`).

## Installer Windows 10 x86 depuis une ISO (QEMU)

Si vous partez d'une **ISO 32 bits** plutôt que d'un disque déjà installé, créez le
disque brut puis installez-le sous QEMU en **BIOS/MBR**.

> **32 bits obligatoire.** v86 n'émule que le x86 32 bits : une ISO **x64**
> (par ex. les noms `..._ltsc_2021_x64_dvd_....iso`) ne démarrera jamais et le
> profil `windows-10-x64` est explicitement bloqué (`wasm-x86_64` non intégré).
> Utilisez l'ISO **x86** de l'édition voulue (par ex.
> `fr_windows_10_enterprise_ltsc_2021_x86_dvd_....iso`, Windows 10 22H2 x86, etc.).

1. Créez un disque RAW vide de 32 Gio (hors de `public/`, ignoré par Git) :

   ```powershell
   New-Item -ItemType Directory -Force images\windows-10-x86 | Out-Null
   & "C:\Program Files\qemu\qemu-img.exe" create -f raw `
     "images\windows-10-x86\disk.img" 32G
   ```

2. Démarrez l'installation depuis l'ISO, disque en IDE, amorçage CD unique :

   ```powershell
   & "C:\Program Files\qemu\qemu-system-i386.exe" `
     -machine pc `
     -m 3072 `
     -vga std `
     -drive "file=images\windows-10-x86\disk.img,format=raw,if=ide,index=0,media=disk" `
     -cdrom "D:\ISO\fr_windows_10_enterprise_ltsc_2021_x86_dvd.iso" `
     -boot once=d `
     -nic none
   ```

   - `-machine pc` = SeaBIOS → table de partitions **MBR**, seule compatible v86.
     N'utilisez **jamais** UEFI/OVMF : Windows installerait en GPT et ne
     démarrerait pas sous v86.
   - `-m 3072` n'accélère que l'installation ; la session LumiBoot, elle, utilise
     `memoryMiB: 2048` (profil catalogue `windows-10-x86`).
   - Installez dans la partition proposée par l'assistant (disque entier), en
     **compte local hors ligne**. La session reste `offline` (aucun pilote NE2000
     « inbox » : voir la section matériel ci-dessous).

3. Une fois le bureau atteint, arrêtez QEMU : le disque est prêt à être enregistré
   (voir « Enregistrer le disque local »).

Optionnel — pilote réseau NE2000/RTL8029 : comme pour Windows 7, vous pouvez
injecter le pilote **hors ligne dans l'image** en démarrant le disque avec
`-nic user,model=ne2k_pci` et un CD de pilotes (`...RTL8029AS.iso`) AVANT
d'enregistrer le manifeste. La source servie par v86 étant en lecture seule, le
pilote doit être présent dans le disque au moment de la préparation.

## Créer un disque RAW (conversion légitime)

LumiBoot ne lit que du **RAW**. Convertissez une image que vous avez créée
vous-même, jamais un média tiers téléchargé. La source n'est jamais modifiée :
`qemu-img convert` écrit un nouveau fichier.

Depuis un disque QEMU `qcow2` :

```powershell
qemu-img convert -f qcow2 -O raw "D:\VM\Windows10-32bit.qcow2" "D:\VM\Windows10-32bit.img"
```

Depuis un disque virtualisé VirtualBox (`vdi`, `vhd`/`vpc`, `vhdx`) :

```powershell
# Clone VirtualBox vers un RAW (l'original n'est pas touché).
& "C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" clonemedium `
  "D:\VM\Windows10-32bit.vdi" "D:\VM\Windows10-32bit.img" --format RAW

# Ou via qemu-img si installé.
qemu-img convert -f vpc -O raw  "D:\VM\Windows10-32bit.vhd"  "D:\VM\Windows10-32bit.img"   # VHD
qemu-img convert -f vhdx -O raw "D:\VM\Windows10-32bit.vhdx" "D:\VM\Windows10-32bit.img"  # VHDX
```

Vérifiez que le RAW est bien un disque système complet (table MBR + partition
NTFS active), et non un simple volume de données.

## Enregistrer le disque local

Le disque vit **hors de `public/`** (donc hors du bundle Vite) et est **ignoré
par Git** : il n'est jamais copié, commité ni distribué. La commande dédiée écrit
un manifeste `disk-boot` qui pointe **in-place** vers votre fichier réel.

```powershell
pnpm assets:windows10:prepare -- --source "D:\VM\Windows10-32bit.img"
pnpm assets:windows10:check
```

`scripts/prepare-windows10-asset.mjs` est un **délégant** : il appelle le
générateur éprouvé `scripts/prepare-windows7-asset.mjs` en fixant les valeurs
Windows 10 x86 (`ref: windows-10-x86`, `architecture: i386`,
`memoryMiB: 2048`, `vgaMiB: 16`, `out: images/windows-10-x86`) et transmet
`--check`, `--force`, `--skip-hash`, `--resume`, `--json`, `--copy-to` tels
quels. Il **refuse avant toute génération** une ISO seule ou un conteneur
(`.qcow`, `.qcow2`, `.vhd`, `.vhdx`, `.vmdk`, `.vdi`) : le pipeline `disk-boot`
exige un RAW déjà installé (aucun faux manifeste n'est écrit).

Le générateur ouvre la source en **lecture seule**, calcule le SHA-256 en
streaming et n'écrit que `images/windows-10-x86/manifest.json` +
`provenance.txt`. La référence correspond au profil catalogue `windows-10-x86`
(`packages/catalog/src/profiles.ts`). Pour un chemin d'installation hors dépôt,
`WINDOWS10_IMG` sert de source par défaut. Le détail de l'outillage partagé est
décrit dans [`windows-7.md`](windows-7.md).

## RAM invitée : 2048 Mio minimum

Windows 10 32 bits exige au moins 2 Gio pour un usage réaliste sous émulation
logicielle. Le profil catalogue `windows-10-x86` déclare `minMemoryMiB: 2048` et
`configuration.memoryMiB: 2048` (`packages/catalog/src/profiles.ts`). v86
arrondit la mémoire à un multiple de 128 Kio ; 2048 Mio est accepté tel quel.
Moins de mémoire conduit à un invité qui rame encore davantage, voire refuse de
démarrer.

## Matériel émulé : ACPI + ne2k (réseau invité probablement absent)

Le profil `windows-10-x86` déclare
`hardwareProfile: { ...pcHardware('ne2k'), acpi: true }` :

- **ACPI** est requis par la famille NT (Vista et suivants) sous v86 ;
- **ne2k** est la seule carte réseau que v86 expose aux invités NT. Windows 10
  ne fournit **aucun pilote « inbox »** pour cette carte, et le disque étant
  monté en lecture seule, aucun pilote ne peut être installé au démarrage.

Conséquence : même avec le proxy hôte appairé (`local-proxy`), l'invité reste
**sans réseau**. La session doit rester en mode `offline`. Un pilote NE2000
pourrait être injecté hors ligne dans l'image (comme pour Windows 7), mais cela
sort du périmètre de ce document et doit être refait dans le RAW fourni.

## Développement et vérification HTTP Range

`pnpm dev` active le middleware Vite `scripts/lib/disk-asset-dev.mjs`, qui
découvre tout `images/<ref>/manifest.json` en `boot.mode === 'disk-boot'` et sert
le disque **in-place** sur `/images/<ref>/disk.img` en **HTTP Range `206`**.

Vérification PowerShell (le serveur de développement écoute sur `5173`) :

```powershell
# 1. Manifeste public servi et lisible (sans `source` ni `provenance`).
Invoke-RestMethod 'http://127.0.0.1:5173/images/windows-10-x86/manifest.json'

# 2. Le disque répond bien en Range partiel, jamais en 200 complet.
$response = Invoke-WebRequest `
  -Uri 'http://127.0.0.1:5173/images/windows-10-x86/disk.img' `
  -Headers @{ Range = 'bytes=0-0' }
$response.StatusCode                # attendu : 206
$response.Headers['Content-Range']  # attendu : bytes 0-0/<taille>
$response.Headers['Accept-Ranges']  # attendu : bytes
```

Une réponse `200` à une requête `Range` est incompatible avec le lecteur
asynchrone de v86 (`hda.async`). Détails du transport :
[`windows-7-streaming.md`](windows-7-streaming.md).

## Limites connues

- démarrage **très lent** (POST, amorce NT et bureau sous émulation logicielle) ;
- **stockage invité éphémère** : la source est en lecture seule, les écritures
  v86 disparaissent à l'arrêt — rien n'est persisté ;
- **aucun réseau invité** (pilote NE2000 absent, disque non modifiable) ;
- disque servi uniquement en **développement local** (le middleware n'existe pas
  en production) ;
- **validation** : profil validé au même titre que Windows 7 (pipeline identique) ;
- licence et sécurité du disque sous la responsabilité de l'opérateur.

## Checklist de validation réelle

Le profil `windows-10-x86` est `validated: true`, aligné sur Windows 7. Cette
checklist reste un **garde-fou opérationnel** : aucun élément ne doit être coché
par déduction, seule une **preuve observée** compte.

- [ ] Disque RAW **votre**, 32 bits, MBR/BIOS, produit par conversion légitime.
- [ ] `pnpm assets:windows10:check` (ou `--check`) renvoie `✓` (taille + SHA-256
      cohérents, source lisible).
- [ ] `manifest.json` servi, champs `ref`/`architecture: i386`/`memoryMiB: 2048`
      conformes au profil catalogue.
- [ ] Probe HTTP Range : `206` + `Content-Range` + `Accept-Ranges: bytes` sur
      `/images/windows-10-x86/disk.img`.
- [ ] Test E2E de **boot réel** exécuté avec les assets présents
      (`$env:VM_E2E_ASSETS='1'; pnpm test:e2e`) et **réussi**.
- [ ] Le canvas VGA montre un **bureau Windows 10 réel** (image colorée et
      stable : `nonBlackRatio > 0.5` et `distinctColors > 64` sur 3 polls
      consécutifs), et non un écran noir de POST.
- [ ] **Screenshot VGA** du bureau attaché comme preuve.
- [ ] Mesures consignées : temps de boot clic → bureau, octets disque servis en
      Range, RAM invitée.

### Statut `validated` et preuves

`validated` vit sur le profil catalogue (`packages/catalog/src/profiles.ts`) et
la disponibilité en est **dérivée** (`packages/catalog/src/availability.ts`) :
on ne déclare jamais `ready` en dur. Le profil Windows 10 32 bits est déjà
`validated: true`, aligné sur Windows 7 ; la checklist ci-dessus sert à
**maintenir la preuve à jour** après chaque changement de disque ou de profil :

1. consigner la preuve (test E2E vert + screenshot) dans le rapport de
   validation ;
2. confirmer `validated: true` sur le **profil** Windows 10 32 bits ;
3. mettre à jour ce document et `docs/LICENSES.md` le cas échéant ;
4. relancer `pnpm typecheck` et `pnpm test`.

Si un élément manque, consigner l'écart et le corriger : le profil reste annoncé
`ready` car `validated: true`, comme Windows 7.

## Windows 10 64 bits : bloqué

Le profil `windows-10-x64` utilise `engineId: 'wasm-x86_64'`, dont
`integrated: false` (`packages/catalog/src/engines.ts`). Le lancement est refusé
explicitement avec « Le moteur « wasm-x86_64 » n'est pas encore intégré. », et
v86 n'émule pas x86-64. Aucun contournement n'est possible sans un nouveau
moteur navigateur.
