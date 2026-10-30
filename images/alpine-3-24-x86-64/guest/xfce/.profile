# ~/.profile: the login shell of tty1 starts the XFCE session after the
# autologin. The serial console keeps a plain shell.
export PS1='lumiboot@lumiboot:\w\$ '

if [ -z "${DISPLAY:-}" ] \
  && [ "$(tty 2>/dev/null)" = "/dev/tty1" ] \
  && command -v startxfce4 >/dev/null 2>&1; then
  # The readiness probe runs beside the session and prints its marker on
  # /dev/ttyS0. It needs root (as the systemd units of the other guests do):
  # the serial device is root/dialout-owned until udev has tagged it, and
  # lumiboot is only in the wheel group, hence `doas -n`.
  setsid doas -n /usr/local/bin/lumiboot-desktop-ready >/dev/null 2>&1 &
  exec /usr/local/bin/lumiboot-startx
fi
