#!/bin/sh
#
# Émission du marqueur de session graphique LumiBoot (flavor xfce).
#
# Ce script est exécuté PAR LE SYSTÈME INVITÉ (unité systemd
# lumiboot-desktop-ready.service). Il ne produit JAMAIS le marqueur à la place
# d'une GUI : il vérifie réellement que
#   1. la socket X du serveur :0 existe,
#   2. le serveur X RÉPOND (xdpyinfo),
#   3. la session XFCE tourne (xfce4-session ou le gestionnaire de fenêtres xfwm4),
# puis écrit LUMIBOOT_DESKTOP_READY:<ref> sur la console série (ttyS0).
#
# Le service tourne en root ; le serveur X a été lancé par l'utilisateur
# « lumiboot » avec un cookie MIT-MAGIC-COOKIE dans ~/.Xauthority. Pour pouvoir
# interroger :0, on pointe donc XAUTHORITY sur le fichier de « lumiboot » (et on
# fixe DISPLAY) : sans cela, xdpyinfo échouerait sur « No protocol specified »
# alors même que X fonctionne.
#
# Si la session graphique ne démarre pas dans le délai, un marqueur d'échec
# distinct est émis et l'unité échoue : aucune GUI n'est déclarée prête à tort.
set -u

REF='debian-12-i386-xfce'
# Délai large : l'émulation logicielle de v86 est lente (démarrage X + XFCE).
DEADLINE=300

export DISPLAY=:0
export XAUTHORITY=/home/lumiboot/.Xauthority

# XFCE peut exposer la session via le gestionnaire de session ou le WM ; les
# deux sont acceptés comme preuve que la session XFCE est réellement vivante.
xfce_session_running() {
  pgrep -x xfce4-session >/dev/null 2>&1 || pgrep -x xfwm4 >/dev/null 2>&1
}

i=0
while [ "$i" -lt "$DEADLINE" ]; do
  if [ -S /tmp/.X11-unix/X0 ] \
    && xdpyinfo >/dev/null 2>&1 \
    && xfce_session_running; then
    printf 'LUMIBOOT_DESKTOP_READY:%s\n' "$REF" > /dev/ttyS0
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

printf 'LUMIBOOT_DESKTOP_START_FAILED:%s\n' "$REF" > /dev/ttyS0
exit 1
