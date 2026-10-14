# Smoke test — Debian 12 i386 sous v86

À exécuter **avant** de passer Debian à `availability: 'ready'`. Résultat attendu : chaque étape
passe, sans exception.

## Navigateurs cibles

- [ ] Chromium / Chrome récent
- [ ] Firefox récent
- [ ] Safari (si supporté par la version de v86 intégrée)

## Étapes

1. [ ] Le catalogue affiche Debian ; le clic sur **Démarrer** prépare les ressources (progression
       **réelle** issue du chargement de l'image, jamais un minuteur).
2. [ ] Une seule transition `booting → running` a lieu, prouvée par l'apparition du prompt invité.
3. [ ] `uname -a` renvoie un noyau Linux (et non une erreur).
4. [ ] `cat /etc/os-release` renvoie `Debian GNU/Linux 12 (bookworm)`.
5. [ ] `ls /` liste une arborescence de type Unix.
6. [ ] `echo hello > /tmp/f && cat /tmp/f` écrit puis relit `hello`.
7. [ ] `poweroff` (ou reboot) rend la main proprement ; un second démarrage fonctionne.
8. [ ] **Arrêter** libère les ressources : pas de worker WASM orphelin à répétition (vérifier
       l'onglet après plusieurs cycles).
9. [ ] Aucune requête HTTP ne déclenche de processus serveur pour cette session locale.

## Mesures à consigner

- Temps de premier démarrage :
- Mémoire navigateur au repos / en session :
- Bande passante téléchargée :
- Comportement mobile (mémoire limitée) :
