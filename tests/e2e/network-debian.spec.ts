import { expect, test, type Locator } from '@playwright/test';

/**
 * **Real** guest network of Debian 12 i386 in v86, `browser-fetch` mode.
 *
 * This file is only enabled when the Debian image is really published, with
 * `rootfs.img`, `vmlinuz-686`, `initrd.img` and `manifest.json`:
 *
 *   $env:VM_E2E_ASSETS='1'; pnpm test:e2e
 *
 * Without that variable, the tests are **skipped**, not "passed": no image, so
 * no possible proof.
 *
 * What these tests deliberately document are the **effective limits** of
 * `v86@0.5.471`, not a "full Internet":
 *
 *  - v86's `fetch` backend only registers TCP for **port 80**: HTTP can
 *    succeed, **HTTPS (443) fails**;
 *  - every request stays **subject to CORS**: a host without an
 *    `Access-Control-Allow-Origin` header is refused by the browser, so
 *    `apt-get update` fails.
 *
 * No CORS proxy and no browser security disabling is used: these failures are
 * the **expected** behavior in `browser-fetch`.
 */
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/**
 * Runs a command on the serial console and returns its output.
 *
 * v86's serial console copies into the *value* of the `<textarea>` everything
 * the guest emits, **including the tty echo**. A marker placed on the same line
 * as the command can therefore be split by a tty line wrap at 80 columns and
 * only appear once. The command is thus framed by **two dedicated, short
 * marker lines**:
 *
 *     echo <begin>
 *     <command>; echo <end>
 *
 * Each printed marker occupies its **own line**, `\n<marker>\n`, which
 * distinguishes it from the echo of the typed line, `... echo <marker>`, and
 * delimits the output unambiguously. Both steps are typed separately: sending
 * the lines in one block saturates the emulated tty and scrambles the echo.
 */
async function probe(
  serial: Locator,
  command: string,
  id: string,
  timeoutMs: number,
): Promise<string> {
  const begin = `__${id}_B__`;
  const end = `__${id}_E__`;
  await serial.click();

  await serial.pressSequentially(`echo ${begin}\n`, { delay: 40 });
  await expect(serial).toHaveValue(new RegExp(`\\n${begin}\\r?\\n`), { timeout: 20_000 });

  await serial.pressSequentially(`${command}; echo ${end}\n`, { delay: 40 });
  await expect(serial).toHaveValue(new RegExp(`\\n${end}\\r?\\n`), { timeout: timeoutMs });

  const value = (await serial.inputValue()) ?? '';
  const endLine = value.lastIndexOf(`\n${end}`);
  const beginLine = value.lastIndexOf(`\n${begin}`, endLine);
  if (beginLine < 0 || endLine < 0) return value.slice(0, Math.max(0, endLine));
  const start = value.indexOf('\n', beginLine + 1) + 1;
  return value.slice(start, endLine);
}

/** Shared path: library -> Debian -> session -> logs -> prompt. */
async function bootDebianAndWaitForPrompt(
  page: import('@playwright/test').Page,
  runningTimeout = 180_000,
): Promise<Locator> {
  await page.goto('/');
  await page.getByLabel('Search for a system').fill('debian');
  await page.locator('.os-card').first().click();
  await expect(page).toHaveURL(/\/systems\//);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/session\//);
  await expect(page.locator('.session-console')).toBeVisible();

  await page.getByRole('button', { name: 'Logs' }).click();

  const state = page.locator('.session-toolbar');
  // `running` is only emitted on proof of the guest marker on ttyS0.
  await expect(state).toHaveAttribute('data-state', 'running', { timeout: runningTimeout });

  const serial = page.locator('.v86-serial');
  await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 90_000 });
  return serial;
}

test.describe('Debian guest network (browser-fetch, real boot)', () => {
  test.skip(!assetsPresent, 'Debian artifacts missing: set VM_E2E_ASSETS=1.');

  // Two real boots per file: they run one after the other so the host machine
  // is not saturated with several emulated VMs at once.
  test.describe.configure({ mode: 'serial' });

  test('DHCP/DNS OK, HTTP OK, HTTPS and apt failing (v86/CORS limits)', async ({ page }) => {
    // Boot + network probes + bounded failures: explicit wall-clock budget.
    test.setTimeout(900_000);

    const serial = await bootDebianAndWaitForPrompt(page);

    // Debian virtio NIC: the `enp0s10` interface is UP and carries an RFC1918
    // address `192.168.x.y` assigned by DHCP.
    const addr = await probe(serial, 'ip -br addr', 'NET_ADDR', 30_000);
    expect(addr).toMatch(/enp0s10\s+UP/);
    expect(addr).toMatch(/192\.168\.\d+\.\d+/);

    const route = await probe(serial, 'ip route', 'NET_ROUTE', 30_000);
    expect(route).toMatch(/192\.168\.\d+\.\d+/);

    // DNS: the name must resolve through systemd-resolved, without any Internet
    // request.
    const dns = await probe(serial, 'getent hosts deb.debian.org', 'NET_DNS', 30_000);
    expect(dns).toMatch(/\d+\.\d+\.\d+\.\d+/);

    // HTTP (port 80): the ONLY port carried by v86's `fetch` backend.
    // `httpbin.org` sends `Access-Control-Allow-Origin: *`, so the request
    // really succeeds. A valid httpbin response is required and no curl error
    // is allowed.
    const http = await probe(
      serial,
      'curl -sS --max-time 20 http://httpbin.org/get',
      'NET_HTTP',
      45_000,
    );
    expect(http).toMatch(/"url"/);
    expect(http).not.toMatch(/curl: \(\d+\)/);

    // HTTPS (443): no TCP connection is registered for 443 by v86 0.5.471, so
    // curl fails with a `000` code, a `curl: (...)` error, or both. Any 2xx/3xx
    // code is explicitly refused: a success would be a lie.
    const https = await probe(
      serial,
      "curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://deb.debian.org/",
      'NET_HTTPS',
      45_000,
    );
    expect(https).toMatch(/curl: \(\d+\)|000/);
    expect(https).not.toMatch(/\b(200|204|301|302|304)\b/);

    // `apt-get update` queries the repositories: the HTTP transport fails
    // because the hosts involved send no CORS header. Expected failure, not a
    // bug.
    const apt = await probe(serial, 'sudo apt-get update', 'NET_APT', 240_000);
    expect(apt).toMatch(/Err:|E: /);

    // Clean stop: the session must reach `stopped` without hanging.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('.session-toolbar')).toHaveAttribute('data-state', 'stopped', {
      timeout: 60_000,
    });
  });

  test('an unreachable relay does not block the lifecycle (start, Stop, Restart)', async ({
    page,
  }) => {
    test.setTimeout(900_000);

    // A `user-relay` mode pointing to a **deliberately unreachable** relay,
    // `127.0.0.1:9` on the discard port, is forced. v86 opens the WebSocket
    // asynchronously: its failure must not prevent the emulator from booting.
    // The config is intercepted at the Playwright network level: the public file
    // is NOT modified, so the other specs running in parallel stay isolated.
    await page.route('**/lumiboot.config.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          network: {
            defaultProfile: { mode: 'user-relay', relayUrl: 'wss://127.0.0.1:9/' },
            systems: {},
          },
        }),
      }),
    );

    // DHCP/network-online may time out more slowly without a relay: boot budget
    // wider than for `browser-fetch`.
    const serial = await bootDebianAndWaitForPrompt(page, 300_000);
    await expect(serial).toHaveValue(/lumiboot@lumiboot/);

    const state = page.locator('.session-toolbar');

    // Stop then restart: the lifecycle stays functional despite the unreachable
    // relay, with no hang and no blocking resource.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 300_000 });
  });
});
