# Debian 12 XFCE

La variante `debian-12-i386-xfce` ajoute une session XFCE complète au même socle Debian/Xorg. Elle est construite, publiée localement et déclarée `validated: true`.

## Profil

| Élément | Valeur |
|---|---|
| Image | `debian-12-i386-xfce` |
| RAM / VGA | 1024 Mio / 16 Mio |
| Disque | ext4 RAW, 4 Gio |
| Session | autologin `lumiboot` → `startx` → `startxfce4` |
| Vidéo | configuration X partagée avec Openbox |
| Readiness | `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` |

Le marqueur desktop exige un serveur X répondant et `xfce4-session` ou `xfwm4` actif. Le délai du profil est de 240 s car XFCE est plus lourd sous émulation logicielle.

## Construire et publier

```bash
sudo FLAVOR=xfce ./images/debian-12-i386/build.sh
mkdir -p apps/web/public/images/debian-12-i386-xfce
cp images/debian-12-i386/build-xfce/{rootfs.img,vmlinuz-686,initrd.img,manifest.json} \
  apps/web/public/images/debian-12-i386-xfce/
```

Build Linux/WSL2 uniquement.

## Validation

Après toute reconstruction, exécuter [`../images/debian-12-i386/tests/xfce-smoke-test.md`](../images/debian-12-i386/tests/xfce-smoke-test.md) et l'E2E réel :

```bash
VM_E2E_ASSETS=1 pnpm test:e2e --grep "XFCE"
```

Les assets restent ignorés par Git. Ne conserver `validated: true` que si le manifeste publié et le boot réel restent valides.
