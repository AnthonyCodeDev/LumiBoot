import { expect, test } from '@playwright/test';

/**
 * Integration of the global configuration and removal of the Settings page.
 *
 * These tests verify three facts observable in the served application:
 *  1. `/settings` no longer exists: no network page is rendered, the
 *     "not found" state is displayed instead.
 *  2. Catalog availability stays DERIVED: Debian, whose real boot is proven,
 *     carries the "Available" badge.
 *  3. `public/lumiboot.config.json` is deployed and served as JSON, never as the
 *     HTML SPA fallback, with version 1 and a default network profile.
 */
test.describe('Global configuration and removal of Settings', () => {
  test('no longer exposes a Settings page (not found state)', async ({ page }) => {
    await page.goto('/settings');

    // The unknown route is caught by `path: '*'`: not-found page visible.
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    // Neither the network panel nor any label of the former Settings page remains.
    await expect(page.getByText('Network settings')).toHaveCount(0);
    await expect(page.locator('.network-panel')).toHaveCount(0);
  });

  test('shows Debian as available in the library', async ({ page }) => {
    await page.goto('/');

    const debianCard = page.locator('.os-card[data-id="debian-12-i386"]');
    await expect(debianCard).toHaveCount(1);

    const badge = debianCard.locator('.card-status');
    await expect(badge).toHaveAttribute('data-state', 'ready');
    await expect(badge).toHaveText('Available');
  });

  test('serves lumiboot.config.json as JSON (version 1 + default network profile)', async ({
    page,
  }) => {
    const response = await page.request.get('/lumiboot.config.json');

    expect(response.ok()).toBeTruthy();
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType).toContain('json');

    const text = await response.text();
    // Never the SPA fallback: the file must contain JSON, not HTML.
    expect(text.trimStart().startsWith('<')).toBe(false);

    const config = JSON.parse(text) as {
      version: unknown;
      network?: { defaultProfile?: unknown };
    };
    expect(config.version).toBe(1);
    expect(config.network?.defaultProfile).toBeDefined();
  });
});
