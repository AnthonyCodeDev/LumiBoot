# Alpine XFCE smoke test

Run after every rebuild of `images/alpine-3-24-x86-64/build.sh` (`FLAVOR=xfce`)
and its publication with `pnpm assets:v64:alpine:xfce`. The profile is
`validated: true` since the 2026-10-30 run recorded at the bottom; revert the
flag as soon as a rebuild stops matching that run.

## Boot

- [ ] The profile starts on the v64 engine with 2048 MiB and a `cdrom` boot
      device, without a JavaScript timeout masquerading as a boot.
- [ ] The serial console shows `lumiboot-init: ISO mounted from /dev/sr0`,
      `switching to the LumiBoot rootfs`, then OpenRC output.
- [ ] `LUMIBOOT_VGA_AUTOLOGIN` appears on ttyS0 before the shell prompt.
- [ ] The VGA screen shows the XFCE panel, wallpaper and `xfwm4` decorations.
- [ ] `LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce` appears on ttyS0 and the
      session leaves the `booting` state for `running`.

## Guest checks (ttyS0 or the VGA terminal)

- [ ] `uname -m` returns `x86_64` and `cat /etc/alpine-release` returns `3.24.3`.
- [ ] `id -un` returns `lumiboot` and `doas -n id -u` returns `0`.
- [ ] `test -f /etc/lumiboot-azerty-ready && echo AZERTY_OK` prints `AZERTY_OK`.
- [ ] `ps -eo comm= | grep -x -e Xorg -e xfce4-session -e xfwm4` lists the three
      processes.
- [ ] `ls -l /tmp/.X11-unix/X0` shows the X socket.
- [ ] `DISPLAY=:0 XAUTHORITY=/home/lumiboot/.Xauthority xdpyinfo | head -3`
      answers with the server name and screens.
- [ ] `setxkbmap -query` reports `layout: fr` and `model: pc105`.
- [ ] `ls -l /usr/libexec/Xorg.wrap` shows the setuid bit (`-rwsr-xr-x`).

## Rootfs and overlay

- [ ] `mount | grep -e lumiboot-rootfs -e overlay` shows the squashfs lower layer
      and the overlay root.
- [ ] `touch /root/overlay-write && ls -l /root/overlay-write` succeeds; stop
      and start again, and the file is gone (writes stay in RAM).
- [ ] A second boot reaches the same marker without reinstalling packages.

## Failure paths

- [ ] Stopping the session then starting it again works, without an orphaned
      worker.
- [ ] If X fails, `LUMIBOOT_DESKTOP_START_FAILED:alpine-3-24-x86-64-xfce`
      appears and no fake `running` state is emitted.

Real E2E: `VM_E2E_ASSETS=1 pnpm test:e2e --grep "Alpine Linux 3.24 x86-64 XFCE"`,
on the Playwright port `5200` (never the developer's `5173`). The spec skips
without the published `manifest.json` and `apps/web/public/v64/v86.wasm`.

## Recorded run — 2026-10-30

Only what `tests/e2e/desktop-alpine-xfce.spec.ts` actually measured is recorded
here; the boxes above stay unticked until the manual commands are run.

- ISO 305 135 616 bytes, rootfs squashfs 249 782 272 bytes, 373 packages, build
  1 min 44.6 s under WSL2.
- `LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce` 132.7 s after the start click;
  the serial tail around the marker was:

  ```text
  LUMIBOOT_VGA_AUTOLOGIN
  lumiboot@lumiboot:~$ LUMIBOOT_DESKTOP_READY:alpine-3-24-x86-64-xfce
  ```

- Session state `running` only after the marker; canvas 1024x768 with mean
  luminance 58.8/255, 99.6 % non-black pixels and 217 distinct colours over the
  three required stable samples.
- No `login:` prompt left on the VGA screen; the spec then stopped the session
  and observed `stopped`.
- Spec result: 1 passed in 5.8 min on the Playwright port 5200.
