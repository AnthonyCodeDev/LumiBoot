# Debian CLI smoke test

Rerun after any change to the image, the manifest or the provider.

- [ ] The session reaches `LUMIBOOT_GUEST_READY:debian-12-i386` then `running`, once.
- [ ] `uname -a` returns a Linux kernel.
- [ ] `cat /etc/os-release` reports Debian 12 Bookworm.
- [ ] `echo hello >/tmp/f && cat /tmp/f` returns `hello`.
- [ ] `poweroff` or the UI stop releases the session; a second boot works.
- [ ] Displayed progress comes from the real load, with no simulated timer.
- [ ] No v86 worker or listener is left after several cycles.

Record: browser, time to marker, peak memory, bytes transferred.
