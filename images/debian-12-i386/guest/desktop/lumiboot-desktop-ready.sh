#!/bin/sh
#
# Emits the desktop marker once the guest X session really runs: the X socket of
# :0 exists, the server answers and the window manager runs. Otherwise a distinct
# failure marker is written and the unit fails.
#
# XAUTHORITY points at the lumiboot cookie file, required to query :0 as root.
set -u

REF='debian-12-i386-desktop'
# Generous deadline: the software emulation of v86 is slow.
DEADLINE=300

export DISPLAY=:0
export XAUTHORITY=/home/lumiboot/.Xauthority

i=0
while [ "$i" -lt "$DEADLINE" ]; do
  if [ -S /tmp/.X11-unix/X0 ] \
    && xdpyinfo >/dev/null 2>&1 \
    && pgrep -x openbox >/dev/null 2>&1; then
    printf 'LUMIBOOT_DESKTOP_READY:%s\n' "$REF" > /dev/ttyS0
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

printf 'LUMIBOOT_DESKTOP_START_FAILED:%s\n' "$REF" > /dev/ttyS0
exit 1
