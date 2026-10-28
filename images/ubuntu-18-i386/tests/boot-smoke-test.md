# Ubuntu 18.04 CLI smoke test

Rerun after any change to the image, the manifest or the provider.

- [ ] The session reaches `LUMIBOOT_GUEST_READY:ubuntu-18-i386` then `running`, once.
- [ ] `uname -a` returns a Linux kernel.
- [ ] `cat /etc/os-release` reports `Ubuntu 18.04.6 LTS` (bionic).
- [ ] `echo hello >/tmp/f && cat /tmp/f` returns `hello`.
- [ ] `sudo -n true` succeeds for the `lumiboot` account.
- [ ] `ping -c1 10.0.2.2` and `getent hosts archive.ubuntu.com` answer (DHCP + DNS).
- [ ] `poweroff` or the UI stop releases the session; a second boot works.
- [ ] Progress reflects the real load, with no simulated timer.
- [ ] No v86 worker or listener is left after several cycles.

Record: browser, time to marker, peak memory, bytes transferred.
