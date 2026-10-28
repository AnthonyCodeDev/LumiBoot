# Debian XFCE smoke test

`validated: true` profile; rerun after any change to the image, the manifest or the provider.

- [ ] `LUMIBOOT_GUEST_READY:debian-12-i386-xfce` appears before the desktop marker.
- [ ] `LUMIBOOT_DESKTOP_READY:debian-12-i386-xfce` triggers `running`.
- [ ] The VGA canvas shows the XFCE panel and `xfwm4`, rendered by the guest.
- [ ] `echo $DISPLAY` returns `:0` and `xdpyinfo` succeeds.
- [ ] `pgrep -x xfce4-session` or `pgrep -x xfwm4` returns a PID.
- [ ] `setxkbmap -query` reports the French keyboard layout.
- [ ] On an X failure, `LUMIBOOT_DESKTOP_START_FAILED` appears and no fake `running` is emitted.
- [ ] Stop then a second boot works, without an orphaned worker.

Real E2E: `VM_E2E_ASSETS=1 pnpm test:e2e --grep "XFCE"`, on port `5200`.
