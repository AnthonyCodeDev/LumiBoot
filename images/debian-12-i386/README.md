# Images Debian 12 i386

Un seul script construit trois variantes Bookworm pour v86 :

| Flavor | Référence | RAM | Disque | Readiness |
|---|---|---:|---:|---|
| `minimal` | `debian-12-i386` | 512 Mio | 3 Gio | `LUMIBOOT_GUEST_READY` |
| `desktop` | `debian-12-i386-desktop` | 1024 Mio | 3 Gio | `LUMIBOOT_DESKTOP_READY` |
| `xfce` | `debian-12-i386-xfce` | 1024 Mio | 4 Gio | `LUMIBOOT_DESKTOP_READY` |

Les trois profils sont actuellement validés. Les images publiées vivent dans `apps/web/public/images/` mais sont ignorées par Git.

## Construction

Prérequis Linux/WSL2 : `debootstrap`, `e2fsprogs`, `util-linux`, `node`, accès root.

```bash
sudo ./images/debian-12-i386/build.sh
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
```

Sorties : `build/`, `build-desktop/` ou `build-xfce/`, contenant `rootfs.img`, `vmlinuz-686`, `initrd.img`, `manifest.json`, `packages.tsv` et `provenance.txt`.

Un snapshot Debian peut être fixé avec `SNAPSHOT=20240101T000000Z`. La taille du disque peut être surchargée avec `DISK_SIZE` et la sortie avec `LUMIBOOT_BUILD_DIR`.

## Publication

Copier les quatre artefacts de boot dans le dossier `apps/web/public/images/<ref>/` correspondant. Ne jamais committer les images.

v86 démarre directement `bzimage + initrd + hda`; il n'utilise pas d'installateur. La ligne de commande standard est `console=tty0 console=ttyS0,115200 root=/dev/sda rw`, avec `vga=0x318` pour les variantes graphiques.

## Validation

- CLI : [`tests/boot-smoke-test.md`](tests/boot-smoke-test.md)
- Openbox : [`tests/desktop-smoke-test.md`](tests/desktop-smoke-test.md)
- XFCE : [`tests/xfce-smoke-test.md`](tests/xfce-smoke-test.md)

Après reconstruction, vérifier les SHA-256 du manifeste et relancer l'E2E avec `VM_E2E_ASSETS=1`.
