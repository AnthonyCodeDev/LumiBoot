# Smoke test Debian CLI

À rejouer après toute modification de l'image, du manifeste ou du provider.

- [ ] La session atteint `LUMIBOOT_GUEST_READY:debian-12-i386` puis `running` une seule fois.
- [ ] `uname -a` renvoie un noyau Linux.
- [ ] `cat /etc/os-release` indique Debian 12 Bookworm.
- [ ] `echo hello >/tmp/f && cat /tmp/f` renvoie `hello`.
- [ ] `poweroff` ou l'arrêt UI libère la session ; un second démarrage fonctionne.
- [ ] Les progrès affichés proviennent du chargement réel, sans minuteur simulé.
- [ ] Aucun worker v86 ni listener ne reste après plusieurs cycles.

À consigner : navigateur, durée jusqu'au marqueur, mémoire maximale et octets transférés.
