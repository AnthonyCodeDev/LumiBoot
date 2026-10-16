# Windows 7 sous v86

Windows 7 forme un groupe de deux variantes validées, démarrées depuis des disques RAW locaux fournis par l'opérateur.

| Variante | Référence | Disque | RAM | Ordre |
|---|---|---:|---:|---:|
| Professionnel SP1 x86 | `windows-7-pro-sp1-x86` | 32 Gio | 1536 Mio | 1, défaut |
| Lite x86 | `windows-7-x86` | 16 Gio | 1024 Mio | 2, mère |

Les fichiers `images/<ref>/disk.img`, `manifest.json` et `provenance.txt` sont ignorés par Git. Aucune image, ISO ou clé Windows n'est distribuée.

## Préparer un disque

```bash
node scripts/prepare-windows7-asset.mjs \
  --source "images/windows-7-pro-sp1-x86/disk.img" \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 --memory-mib 1536 --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86

pnpm assets:windows7:check
```

Le script ouvre la source en lecture seule, calcule le SHA-256 en streaming et écrit le manifeste sans copier le disque. `--resume` réutilise le hash si taille et `mtime` concordent ; `--force` autorise le remplacement du manifeste.

## Développement

`pnpm dev` active le middleware Vite de `scripts/lib/disk-asset-dev.mjs`. Il découvre chaque manifeste `disk-boot` et sert le disque in-place sur `/images/<ref>/disk.img` avec HTTP Range `206`.

Le disque est monté comme `hda.async`, jamais comme CD-ROM. Les écritures v86 restent en mémoire et disparaissent à l'arrêt ; la source n'est pas modifiée.

## Readiness

Windows n'émet pas de marqueur LumiBoot. Le mode `disk-boot` passe à `running` après une première lecture IDE réelle du disque. Cette preuve confirme l'amorçage, pas à elle seule un bureau fonctionnel ; le test visuel E2E couvre ensuite le canvas VGA.

```bash
$env:VM_E2E_ASSETS='1'
pnpm test:e2e --grep "Windows 7"
```

Playwright utilise le port `5200`. Les tests réels restent désactivés sans `VM_E2E_ASSETS=1` car les disques font 16 et 32 Gio.

## Réseau (Internet dans l'invité)

v86 expose à Windows 7 une carte **NE2000 (`ne2k`)**. Les profils `windows-7-pro-sp1-x86` et `windows-7-x86` déclarent `hardwareProfile: { ...pcHardware('ne2k'), acpi: true }` (`packages/catalog/src/profiles.ts`), traduit en `net_device.type = 'ne2k'` par `toV86NetworkDeviceType` (`packages/provider-v86/src/network/V86NetworkAdapter.ts`). Côté invité, la carte n'est utilisable qu'avec un **pilote NE2000/RTL8029**.

Windows 7 (famille Vista+) ne fournit **aucun pilote « inbox »** pour cette carte. Même si le proxy hôte tourne et que la session est en `local-proxy`, l'invité affiche « Aucune connexion n'est disponible » et aucun réseau. La documentation officielle v86 le confirme : [§5.3 Enabling networking (ne2k)](https://github.com/copy/v86/blob/master/docs/windows-nt.md).

Le pilote doit être installé **dans l'image `disk.img`**. Or LumiBoot monte le disque en lecture seule (`hda.async`, HTTP Range) et les écritures v86 restent en mémoire et disparaissent à l'arrêt (voir la section « Développement » ci-dessus). L'installation se fait donc **hors ligne, dans QEMU**, avant de préparer ou de patcher le manifeste.

### Installer le pilote hors ligne (QEMU)

Démarrer le disque avec un contrôleur NE2000 émulé et un CD-ROM contenant les pilotes :

```bash
qemu-system-i386 \
  -drive file=images/windows-7-pro-sp1-x86/disk.img,format=raw,if=ide \
  -m 1536 \
  -net nic,model=ne2k_pci -net user \
  -cdrom drivers-ne2000.iso
```

1. monter l'ISO de pilotes NE2000/RTL8029 (ou son dossier extrait) ;
2. ouvrir le Gestionnaire de périphériques et sélectionner le « Ethernet Controller » inconnu ;
3. **Mettre à jour le pilote** → « Parcourir mon ordinateur à la recherche d'un pilote » → pointer le dossier ou le CD ;
4. accepter « Installer ce pilote logiciel quand même » si Windows signale un pilote non signé ;
5. redémarrer l'invité, puis vérifier avec `ipconfig /all` que la carte obtient une adresse.

Après l'installation, re-préparer le manifeste pour que LumiBoot serve le disque modifié :

```bash
pnpm assets:windows7:prepare -- \
  --source "images/windows-7-pro-sp1-x86/disk.img" \
  --ref windows-7-pro-sp1-x86 \
  --display-name "Windows 7 Professionnel SP1 x86" \
  --architecture i386 --memory-mib 1536 --vga-mib 16 \
  --out images/windows-7-pro-sp1-x86

pnpm assets:windows7:check
```

### Condition côté LumiBoot

Le `net_device` n'est émis que si le mode effectif est `local-proxy` (proxy **appairé**, pas seulement démarré) ou `user-relay`. Sinon :

| Mode effectif | Réseau invité |
|---|---|
| `local-proxy` | WISP vers le proxy appairé, TCP sortant uniquement |
| `user-relay` | WISP vers un relais `wss://` |
| `browser-fetch` | HTTP 80 seulement, CORS, pas de HTTPS |
| `offline` | aucune NIC |

Le mode est résolu au démarrage de la session (`selectEffectiveNetworkProfile`, `apps/web/src/features/sessions/sessions.store.ts`) et **figé** pour la session : appairer le proxy ne suffit pas, il faut **redémarrer la session** ensuite. Références : [`network.md`](network.md), [`network-proxy.md`](network-proxy.md).

### Vérifier

- dans l'invité : `ipconfig /all` ;
- dans LumiBoot : le badge réseau de la barre d'outils (`data-testid="session-network-mode"`) affiche le mode effectif.

## Limites

- émulation x86 logicielle, donc démarrage lent ;
- aucune persistance des écritures ;
- disques disponibles uniquement en développement local sauf serveur Range explicitement déployé ;
- licence et sécurité des disques sous la responsabilité de l'opérateur.

Détails du transport Range : [`windows-7-streaming.md`](windows-7-streaming.md).
