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

## Limites

- émulation x86 logicielle, donc démarrage lent ;
- aucune persistance des écritures ;
- disques disponibles uniquement en développement local sauf serveur Range explicitement déployé ;
- licence et sécurité des disques sous la responsabilité de l'opérateur.

Détails du transport Range : [`windows-7-streaming.md`](windows-7-streaming.md).
