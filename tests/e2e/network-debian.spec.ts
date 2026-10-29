import { expect, test, type Locator } from '@playwright/test';

// Real Debian guest network (browser-fetch): port 80 only, CORS still enforced.
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

// Guest HTTP target: port 80 with `Access-Control-Allow-Origin: *` (E2E_HTTP_TARGET).
const E2E_HTTP_TARGET = process.env.E2E_HTTP_TARGET || 'http://httpbin.org/get';

/** Guest HTTPS target: the host deliberately failing on 443 (`E2E_HTTPS_TARGET`). */
const E2E_HTTPS_TARGET = process.env.E2E_HTTPS_TARGET || 'https://deb.debian.org/';

/** The discard port on loopback: valid for the validator, never reachable. */
const DISCARD_WISP_URL = 'wss://127.0.0.1:9/';

// Runs a command between two marker lines (the tty echo would corrupt one line).
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

  // Serial: one boot at a time so the host is not saturated by emulated VMs.
  test.describe.configure({ mode: 'serial' });

  test('DHCP/DNS OK, HTTP OK, HTTPS and apt failing (v86/CORS limits)', async ({ page }) => {
    // Boot + network probes + bounded failures: explicit wall-clock budget.
    test.setTimeout(900_000);

    const serial = await bootDebianAndWaitForPrompt(page);

    // virtio NIC: `enp0s10` is UP with an RFC1918 address assigned by DHCP.
    const addr = await probe(serial, 'ip -br addr', 'NET_ADDR', 30_000);
    expect(addr).toMatch(/enp0s10\s+UP/);
    expect(addr).toMatch(/192\.168\.\d+\.\d+/);

    const route = await probe(serial, 'ip route', 'NET_ROUTE', 30_000);
    expect(route).toMatch(/192\.168\.\d+\.\d+/);

    // DNS resolves through systemd-resolved, without any Internet request.
    const dns = await probe(serial, 'getent hosts deb.debian.org', 'NET_DNS', 30_000);
    expect(dns).toMatch(/\d+\.\d+\.\d+\.\d+/);

    // HTTP (port 80): the only port registered by v86's `fetch` backend.
    const http = await probe(
      serial,
      `curl -sS --max-time 20 ${E2E_HTTP_TARGET}`,
      'NET_HTTP',
      45_000,
    );
    expect(http).toMatch(/"url"/);
    expect(http).not.toMatch(/curl: \(\d+\)/);

    // HTTPS (443) is not registered by v86 0.5.471: curl must fail, never 2xx.
    const https = await probe(
      serial,
      `curl -sS --max-time 15 -o /dev/null -w '%{http_code}' ${E2E_HTTPS_TARGET}`,
      'NET_HTTPS',
      45_000,
    );
    expect(https).toMatch(/curl: \(\d+\)|000/);
    expect(https).not.toMatch(/\b(200|204|301|302|304)\b/);

    // `apt-get update` fails: the repositories send no CORS header.
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

    // Unreachable relay forced via page.route: the public config stays untouched.
    await page.route('**/lumiboot.config.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          network: {
            defaultProfile: { mode: 'user-relay', relayUrl: DISCARD_WISP_URL },
            systems: {},
          },
        }),
      }),
    );

    // Without a relay, network-online may be slower: wider boot budget.
    const serial = await bootDebianAndWaitForPrompt(page, 300_000);
    await expect(serial).toHaveValue(/lumiboot@lumiboot/);

    const state = page.locator('.session-toolbar');

    // Stop and restart still work with an unreachable relay, without hanging.
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(state).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Restart' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 300_000 });
  });
});
