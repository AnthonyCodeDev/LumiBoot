#!/bin/sh
#
# Emits the desktop marker once the XFCE session really runs: the X socket of :0
# exists, the server answers and the session manager or the WM runs. Otherwise a
# distinct failure marker is written and the unit fails, so a build is never
# mistaken for a validated boot.
#
# XAUTHORITY points at the lumiboot cookie file, required to query :0 as root.
# @REF@ is substituted by build.sh.
set -u

# Generous deadline: the software emulation of v64 is slow.
DEADLINE=300

export DISPLAY=:0
export XAUTHORITY=/home/lumiboot/.Xauthority

# The console keymap is re-applied here, as in the console flavor: the vconsole
# units can run before the getty hands tty1 to the visitor.
systemctl restart systemd-vconsole-setup.service >/dev/null 2>&1 || true
touch /etc/lumiboot-azerty-ready

# Both the session manager and the WM prove the session is alive.
session_running() {
  pgrep -x xfce4-session >/dev/null 2>&1 || pgrep -x xfwm4 >/dev/null 2>&1
}

i=0
while [ "$i" -lt "$DEADLINE" ]; do
  if [ -S /tmp/.X11-unix/X0 ] && xdpyinfo >/dev/null 2>&1 && session_running; then
    printf 'LUMIBOOT_DESKTOP_READY:@REF@\n' | tee /dev/ttyS0 /dev/tty1 >/dev/null
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

printf 'LUMIBOOT_DESKTOP_START_FAILED:@REF@\n' > /dev/ttyS0
exit 1
