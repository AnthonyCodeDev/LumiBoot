# Ubuntu 18.04 XFCE smoke test

The `ubuntu-18-i386-xfce` image is published and the profile is `validated: true`; rerun this checklist after any rebuild and revert the flag if it no longer matches.

- [ ] `LUMIBOOT_GUEST_READY:ubuntu-18-i386-xfce` appears before the desktop marker.
- [ ] `LUMIBOOT_DESKTOP_READY:ubuntu-18-i386-xfce` triggers `running`.
- [ ] The VGA canvas shows the XFCE panel and `xfwm4`, rendered by the guest.
- [ ] `echo $DISPLAY` returns `:0` and `xdpyinfo` succeeds.
- [ ] `pgrep -x xfce4-session` or `pgrep -x xfwm4` returns a PID.
- [ ] `setxkbmap -query` reports the French keyboard layout.
- [ ] `cat /etc/os-release` reports `Ubuntu 18.04.6 LTS` (bionic).
- [ ] On an X failure, `LUMIBOOT_DESKTOP_START_FAILED` appears and no fake `running` is emitted.
- [ ] Stop then a second boot works, without an orphaned worker.

Real E2E: `VM_E2E_ASSETS=1 pnpm test:e2e --grep "Ubuntu"`, on port `5200`.
