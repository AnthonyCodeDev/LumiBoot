import { expect, test, type Locator } from '@playwright/test';

// Opt-in WISP relay test: needs LUMIBOOT_WISP_RELAY_URL + VM_E2E_ASSETS=1.
const relay = process.env.LUMIBOOT_WISP_RELAY_URL;
const assetsPresent = process.env.VM_E2E_ASSETS === '1';

// Guest HTTPS target (any host on 443), overridable via E2E_HTTPS_TARGET.
const E2E_HTTPS_TARGET = process.env.E2E_HTTPS_TARGET || 'https://deb.debian.org/';

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

    // The relay must be a real `wss:` URL: validation rejects anything else.
    const relayUrl = relay ?? '';
    expect(relayUrl).toMatch(/^wss:\/\//);

    // `user-relay` injected via page.route: the public file stays untouched.
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

    // HTTPS through the relay: a real WISP relay carries arbitrary TCP.
    const https = await probe(serial, `curl -I ${E2E_HTTPS_TARGET}`, 'WISP_HTTPS', 90_000);
    expect(https).toMatch(/HTTP\/1\.[01] [23]\d\d/);

    // End-to-end `apt-get update` must succeed through the relay.
    const apt = await probe(serial, 'sudo apt-get update', 'WISP_APT', 300_000);
    expect(apt).not.toMatch(/Err:/);
    expect(apt).not.toMatch(/E: /);
    expect(apt).toMatch(/Reading package lists|Hit:|Get:/);
  });
});
