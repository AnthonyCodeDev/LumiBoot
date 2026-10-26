#!/bin/sh
#
# Emission of the LumiBoot graphical session marker (xfce flavor).
#
# This script is executed BY THE GUEST SYSTEM (systemd unit
# lumiboot-desktop-ready.service). It NEVER produces the marker in place of a
# GUI: it really checks that
#   1. the X socket of server :0 exists,
#   2. the X server ANSWERS (xdpyinfo),
#   3. the XFCE session runs (xfce4-session or the xfwm4 window manager),
# then writes LUMIBOOT_DESKTOP_READY:<ref> to the serial console (ttyS0).
#
# The service runs as root; the X server was started by the "lumiboot" user with
# a MIT-MAGIC-COOKIE in ~/.Xauthority. To be able to query :0, XAUTHORITY is
# therefore pointed at the "lumiboot" file (and DISPLAY is set): without that,
# xdpyinfo would fail with "No protocol specified" even though X works.
#
# If the graphical session does not start within the deadline, a distinct
# failure marker is emitted and the unit fails: no GUI is wrongly declared
# ready.
set -u

REF='debian-12-i386-xfce'
# Generous deadline: the software emulation of v86 is slow (X + XFCE start).
DEADLINE=300

export DISPLAY=:0
export XAUTHORITY=/home/lumiboot/.Xauthority

# XFCE can expose the session through the session manager or the WM; both are
# accepted as proof that the XFCE session is really alive.
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
