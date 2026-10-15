# Smoke test — Debian 12 i386 **Desktop** (Xorg + Openbox) sous v86

> **NON EXÉCUTÉ / NON TESTÉ.** Aucun boot graphique réel n'a été effectué dans l'environnement de
> développement (pas de `debootstrap`/WSL/Docker, aucune image construite). Ce document décrit la
> procédure à suivre **sur une machine adaptée** avant tout passage en `ready`.
>
> Ce test est **distinct** de `boot-smoke-test.md` (flavor console). Il exige le smoke test console
> **déjà vert** : si l'OS ne démarre pas en console, la GUI ne peut pas démarrer.

## Prérequis

- Image `debian-12-i386-desktop` construite (`FLAVOR=desktop ./images/debian-12-i386/build.sh`) et
  publiée dans `apps/web/public/images/debian-12-i386-desktop/`.
- `manifest.json` réel présent (SHA-256 calculés) ; le catalogue référence alors `imageRef`.
- Profil `debian-12-i386-desktop` exécuté avec ≥ 1 Gio de mémoire.

## Navigateurs cibles

- [ ] Chromium / Chrome récent
- [ ] Firefox récent
- [ ] Safari (si supporté par la version de v86 intégrée)

## Étapes

1. [ ] Le catalogue affiche **Debian (Bureau)** ; le lancement prépare les ressources (progression
       **réelle**, jamais un minuteur).
2. [ ] Le marqueur `LUMIBOOT_GUEST_READY:debian-12-i386-desktop` apparaît sur la console série
       (**OS opérationnel**).
3. [ ] Le marqueur `LUMIBOOT_DESKTOP_READY:debian-12-i386-desktop` apparaît **ensuite**, uniquement
       après le démarrage effectif du serveur X et de la session.
4. [ ] L'écran VGA affiche une **session graphique réelle** : Openbox + une fenêtre `xterm`.
5. [ ] Dans le `xterm` : `uname -a` renvoie un noyau Linux ; `cat /etc/os-release` renvoie
       `Debian GNU/Linux 12 (bookworm)`.
6. [ ] `echo $DISPLAY` renvoie `:0` ; `xdpyinfo | head` répond (serveur X vivant).
7. [ ] `pgrep -x openbox` renvoie un PID (gestionnaire de fenêtres actif).
8. [ ] Le clavier est en **AZERTY fr** dans la session X (`setxkbmap -query`).
9. [ ] `poweroff` (ou reboot) rend la main proprement ; un second démarrage fonctionne.
10. [ ] **Arrêter** libère les ressources : pas de worker WASM ni de processus X orphelin après
        plusieurs cycles.

## Preuve d'honnêteté (à vérifier explicitement)

- [ ] **Aucun** marqueur `LUMIBOOT_DESKTOP_READY` n'est émis si le serveur X échoue : dans ce cas,
       la console série doit montrer `LUMIBOOT_DESKTOP_START_FAILED:debian-12-i386-desktop` et la
       session ne doit **pas** passer à `running` sur la foi d'une GUI simulée.
- [ ] La `xterm` et Openbox viennent bien de l'**invité**, jamais d'un rendu React.

## Mesures à consigner

- Temps de premier démarrage (jusqu'à `GUEST_READY` puis jusqu'à `DESKTOP_READY`) :
- Mémoire navigateur au repos / en session graphique :
- Bande passante téléchargée :
- Comportement mobile (mémoire limitée) :

## Critères de passage en `ready`

Tous les points ci-dessus **verts**, sur au moins un navigateur, **plus** un boot graphique rejouable
et reproductible. Alors seulement : renseigner `imageRef` dans `packages/catalog/src/images.ts` et
passer `validated: true` dans `packages/catalog/src/profiles.ts`.
