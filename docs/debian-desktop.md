# Debian 12 X11/Openbox

La variante `debian-12-i386-desktop` ajoute Xorg, Openbox et xterm au socle Debian CLI. Elle est construite, publiée localement et déclarée `validated: true`.

## Profil

| Élément | Valeur |
|---|---|
| Image | `debian-12-i386-desktop` |
| RAM / VGA | 1024 Mio / 16 Mio |
| Disque | ext4 RAW, 3 Gio |
| Session | autologin `lumiboot` → `startx` → Openbox + xterm |
| Vidéo | `fbdev`, repli `modesetting`, noyau `vga=0x318` |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` |

Le marqueur desktop n'est émis qu'après réponse de `xdpyinfo` et détection d'Openbox. `LUMIBOOT_GUEST_READY` indique seulement que l'OS a atteint `multi-user.target`.

## Construire et publier

Prérequis Linux/WSL2 : `debootstrap`, `e2fsprogs`, `util-linux`, `node`.

```bash
sudo FLAVOR=desktop ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-desktop
cp images/debian-12-i386/build-desktop/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-desktop/
```

Ne pas exécuter le build sous Windows natif : il utilise `debootstrap`, `chroot` et le montage ext4.

## Validation

Après toute reconstruction, exécuter [`../images/debian-12-i386/tests/desktop-smoke-test.md`](../images/debian-12-i386/tests/desktop-smoke-test.md) et l'E2E réel :

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "Bureau"
```

Les assets restent ignorés par Git. `imageRef` et `validated: true` ne doivent être conservés que tant que le manifeste publié et le boot réel sont valides.
