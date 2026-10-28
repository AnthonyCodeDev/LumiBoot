import { expect, test, type Locator } from '@playwright/test';

/**
 * Real guest network through a personal **WISP relay**, `user-relay` mode.
 *
 * This test is **opt-in**: it is never run, nor reported as passed, without a
 * real v86-compatible WISP relay provided by the user. The relay address is
 * **never** hard-coded, neither in the sources nor in CI: it only comes from
 * the `LUMIBOOT_WISP_RELAY_URL` environment variable.
 *
 * Enabling it:
 *
 *   $env:LUMIBOOT_WISP_RELAY_URL='wss://relay.example.org/wisp'
 *   $env:VM_E2E_ASSETS='1'
 *   pnpm test:e2e --grep "WISP"
 *
 * Without both variables, every case is **skipped**.
 *
 * The `user-relay` profile is injected through **Playwright request
 * interception**, with `page.route` on `lumiboot.config.json`, as
 * `network-debian.spec.ts` already does for the unreachable relay. The public
 * `apps/web/public/lumiboot.config.json` file is **never** modified: no parallel
 * run or interruption can leave the repository altered.
 */
const relay = process.env.LUMIBOOT_WISP_RELAY_URL;
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

/** Same helper as `network-debian.spec.ts`, with the output isolated by markers. */
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

test.describe('WISP network (user-relay, opt-in)', () => {
  test.skip(
    !relay || !assetsPresent,
    'Test WISP relay (LUMIBOOT_WISP_RELAY_URL) + artifacts (VM_E2E_ASSETS=1) required.',
  );

  test('the WISP relay carries HTTPS and makes apt-get update work', async ({ page }) => {
    test.setTimeout(1_200_000);

    // The relay must be a real TLS WISP relay; a raw invalid address would fail
    // the profile validation anyway.
    const relayUrl = relay ?? '';
    expect(relayUrl).toMatch(/^wss:\/\//);

    // Injection of the `user-relay` profile at the Playwright network level: the
    // public file is NOT modified, so the other parallel specs stay isolated.
    await page.route('**/lumiboot.config.json', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 1,
          network: { defaultProfile: { mode: 'user-relay', relayUrl }, systems: {} },
          proxy: { enabled: true },
        }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    await page.locator('.os-card').first().click();
    await page.getByRole('button', { name: 'Start session' }).click();
    await expect(page).toHaveURL(/\/session\//);
    await expect(page.locator('.session-console')).toBeVisible();

    await page.getByRole('button', { name: 'Logs' }).click();

    const state = page.locator('.session-toolbar');
    await expect(state).toHaveAttribute('data-state', 'running', { timeout: 180_000 });

    const serial = page.locator('.v86-serial');
    await expect(serial).toHaveValue(/lumiboot@lumiboot/, { timeout: 90_000 });

    // DHCP/DNS through the relay.
    const addr = await probe(serial, 'ip -br addr', 'WISP_ADDR', 30_000);
    expect(addr).toMatch(/enp0s10\s+UP/);
    expect(addr).toMatch(/192\.168\.\d+\.\d+/);

    const dns = await probe(serial, 'getent hosts deb.debian.org', 'WISP_DNS', 30_000);
    expect(dns).toMatch(/\d+\.\d+\.\d+\.\d+/);

    // HTTPS (443) THROUGH the relay: a real WISP relay carries arbitrary TCP, so
    // curl must get a 2xx/3xx HTTP response.
    const https = await probe(serial, 'curl -I https://deb.debian.org/', 'WISP_HTTPS', 90_000);
    expect(https).toMatch(/HTTP\/1\.[01] [23]\d\d/);

    // End-to-end `apt-get update`: no `Err:`/`E:` error may show up, and apt must
    // really list/read the repositories.
    const apt = await probe(serial, 'sudo apt-get update', 'WISP_APT', 300_000);
    expect(apt).not.toMatch(/Err:/);
    expect(apt).not.toMatch(/E: /);
    expect(apt).toMatch(/Reading package lists|Hit:|Get:/);
  });
});
