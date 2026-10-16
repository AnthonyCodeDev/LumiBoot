# Smoke test Debian XFCE

Le profil est actuellement `validated: true`. Rejouer ce test après toute modification de l'image, du manifeste ou du provider.

- [ ] `LUMIBOOT_GUEST_READY:debian-12-i386-xfce` apparaît avant le marqueur desktop.
- [ ] `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` déclenche `running`.
- [ ] Le canvas VGA montre le panneau XFCE et `xfwm4`; ce rendu provient de l'invité.
- [ ] `echo $DISPLAY` renvoie `:0` et `xdpyinfo` réussit.
- [ ] `pgrep -x xfce4-session` ou `pgrep -x xfwm4` renvoie un PID.
- [ ] `setxkbmap -query` indique le clavier français.
- [ ] En cas d'échec X, `LUMIBOOT_DESKTOP_START_FAILED` apparaît et aucun faux `running` n'est émis.
- [ ] L'arrêt puis un second démarrage fonctionnent sans worker orphelin.

E2E réel : `VM_E2E_ASSETS=1 pnpm test:e2e --grep "XFCE"` sur le port Playwright `5200`.
