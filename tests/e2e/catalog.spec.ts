import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const REPO_ROOT = process.cwd();
// The local disk is Git-ignored: CI has none, a developer machine may have one.
const WINDOWS11_DISK = join(REPO_ROOT, 'images', 'windows-11-x64', 'disk.img');

test.describe('Library', () => {
  test('shows the eleven displayed catalog systems (mothers + standalone)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
    // Child variants fold onto their mother card: 11 mother/standalone cards.
    await expect(page.locator('.os-card')).toHaveCount(11);
  });

  test('searches for a system and filters by family', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('debian');
    // "debian" matches console/Desktop/XFCE, but only the mother card is shown.
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="debian-12-i386"]')).toHaveCount(1);
    // Child variants are never displayed as standalone cards.
    await expect(page.locator('.os-card[data-id="debian-12-i386-desktop"]')).toHaveCount(0);
    await expect(page.locator('.os-card[data-id="debian-12-i386-xfce"]')).toHaveCount(0);

    await page.getByLabel('Search for a system').fill('');
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(4);

    // No Custom chip anymore: the generic entry stays visible under All.
    await expect(page.locator('[data-filter="custom"]')).toHaveCount(0);
    await expect(page.locator('.filter-chips [data-filter]')).toHaveCount(4);
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.locator('.os-card')).toHaveCount(11);
    await expect(page.locator('.os-card[data-id="custom-image"]')).toHaveCount(1);
  });

  test('a click opens the page directly (no popup)', async ({ page }) => {
    await page.goto('/');
    await page.locator('.os-card').first().click();
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the Enter key on a card navigates to the page', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('.os-card').first();
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/systems\//);
    await expect(page.locator('.detail-drawer')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

// Facet counts come from the catalog (11 displayed cards): 6 x 32 bits (i386),
// 4 x 64 bits (x86_64: Fedora, Alpine, Windows 11, macOS Lion) and 1 ARM 64 bits
// (macOS Sequoia).
test.describe('Facet filters', () => {
  test('facet filters narrow the library', async ({ page }) => {
    await page.goto('/');

    const architectureTrigger = page.getByRole('button', { name: /^Architecture filter/ });
    const architectureMenu = page.getByRole('group', { name: 'Architecture' });
    await expect(architectureTrigger).toHaveAttribute('aria-expanded', 'false');

    await architectureTrigger.click();
    await expect(architectureTrigger).toHaveAttribute('aria-expanded', 'true');
    await expect(architectureMenu.getByRole('checkbox')).toHaveCount(3);
    await expect(architectureMenu.locator('[data-value="i386"] .facet-option-count')).toHaveText(
      '6',
    );
    await expect(architectureMenu.locator('[data-value="x86_64"] .facet-option-count')).toHaveText(
      '4',
    );
    await expect(architectureMenu.locator('[data-value="arm64"] .facet-option-count')).toHaveText(
      '1',
    );

    // 64 bits: Fedora, Alpine, Windows 11 and macOS Lion only.
    await architectureMenu.locator('[data-value="x86_64"]').click();
    await expect(architectureMenu.locator('[data-value="x86_64"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // No count badge: the selection is only exposed through the trigger label.
    await expect(architectureTrigger).toHaveAttribute(
      'aria-label',
      'Architecture filter, 1 selected',
    );
    await expect(page.locator('.facet-count')).toHaveCount(0);
    await expect(page.locator('.os-card')).toHaveCount(4);
    await expect(page.locator('.os-card[data-id="debian-12-i386"]')).toHaveCount(0);
    for (const id of [
      'fedora-44-x86-64',
      'alpine-3-24-x86-64',
      'windows-11-x64',
      'macos-lion-x64',
    ]) {
      await expect(page.locator(`.os-card[data-id="${id}"]`)).toHaveCount(1);
    }

    // Family and facet intersect.
    await page.getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('.os-card')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="windows-11-x64"]')).toHaveCount(1);
    await expect(page.locator('.os-card[data-id="windows-7-x86"]')).toHaveCount(0);

    // Reopen the panel and uncheck the option: the grid widens back.
    await expect(architectureTrigger).toHaveAttribute('aria-expanded', 'false');
    await architectureTrigger.click();
    await expect(architectureMenu.locator('[data-value="x86_64"]')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await architectureMenu.locator('[data-value="x86_64"]').click();
    await expect(architectureMenu.locator('[data-value="x86_64"]')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(page.locator('.os-card')).toHaveCount(4);
    await expect(page.locator('.os-card[data-id="windows-7-x86"]')).toHaveCount(1);
    // No tags in the trigger and no Clear action in the panel.
    await expect(page.locator('.facet-tag')).toHaveCount(0);
    await expect(page.locator('.facet-count')).toHaveCount(0);
    await expect(architectureTrigger).toHaveAttribute(
      'aria-label',
      'Architecture filter, no selection',
    );
    await expect(architectureMenu.getByRole('button', { name: 'Clear' })).toHaveCount(0);

    // Escape folds the panel and keeps aria-expanded in sync.
    await page.keyboard.press('Escape');
    await expect(architectureTrigger).toHaveAttribute('aria-expanded', 'false');
    await expect(architectureMenu).toHaveCount(0);
  });

  // `.filter:hover` must never win over the active/open rules (same specificity otherwise).
  test('an active filter keeps its selected look on hover', async ({ page }) => {
    await page.goto('/');

    // Tokens from global.css: --primary-soft: #1b2445, active text: #b9c5ff.
    const activeBackground = 'rgb(27, 36, 69)';
    const activeText = 'rgb(185, 197, 255)';
    const mutedBackground = 'rgb(25, 29, 38)'; // --surface-muted: #191d26

    const all = page.getByRole('button', { name: 'All' });
    await expect(all).toHaveClass(/active/);
    await all.hover();
    await expect(all).toHaveCSS('background-color', activeBackground);
    await expect(all).toHaveCSS('color', activeText);

    // A non-active chip keeps the muted hover look.
    const linux = page.getByRole('button', { name: 'Linux' });
    await linux.hover();
    await expect(linux).toHaveCSS('background-color', mutedBackground);

    const architectureTrigger = page.getByRole('button', { name: /^Architecture filter/ });
    await architectureTrigger.click();
    await page.getByRole('checkbox', { name: /^64 bits/ }).click();
    // Open panel: the active look survives the hover.
    await architectureTrigger.hover();
    await expect(architectureTrigger).toHaveCSS('background-color', activeBackground);
    await expect(architectureTrigger).toHaveCSS('color', activeText);

    await page.keyboard.press('Escape');
    await architectureTrigger.hover();
    await expect(architectureTrigger).toHaveCSS('background-color', activeBackground);
    await expect(architectureTrigger).toHaveCSS('color', activeText);
  });
});

// Windows 11 x64 is "Available" (real boot to the logged-in Windows 11 desktop,
// patched v64 build); the generic "Custom image" needs user media.
test.describe('Windows 11 and the generic custom image', () => {
  test('Windows 11 is "Available", without an import card', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('.os-card[data-id="windows-11-x64"]');
    await expect(card).toHaveCount(1);
    // `ready` renders as "Available": the local disk is the operator's, not user media.
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'ready');
    await expect(card.locator('.card-status')).toHaveText('Available');
    // Playable: first group, full opacity, not greyed out.
    await expect(card).not.toHaveClass(/is-muted/);
    // macOS Sequoia is still `planned`, so the separator between the two groups remains.
    await expect(page.locator('.cards-separator')).toHaveCount(1);

    await card.click();
    await expect(page).toHaveURL(/\/systems\/windows-11-x64$/);
    await expect(page.getByText('Required media (provided by you)')).toHaveCount(0);

    // A local-disk system is launchable as soon as its engine is integrated and its
    // disk is referenced; the runtime check (manifest + HTTP Range) then decides.
    const start = page.getByRole('button', { name: 'Start session' });
    if (existsSync(WINDOWS11_DISK)) {
      await expect(start).toBeEnabled();
    } else {
      // Deterministic in CI: no disk served, so the button stays disabled.
      await expect(start).toBeDisabled();
    }
  });

  test('the custom image is "Resource required" and exposes the import card', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('.os-card[data-id="custom-image"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'resource-required');
    await expect(card.locator('.card-status')).toHaveText('Resource required');
    // Playable: first group, full opacity, not greyed out.
    await expect(card).not.toHaveClass(/is-muted/);
    await expect(card).toHaveCSS('opacity', '1');
    // Its group holds no pending card, and the separator comes after it.
    const playableGroup = page.locator('.cards').first();
    await expect(playableGroup.locator('.os-card[data-id="custom-image"]')).toHaveCount(1);
    await expect(playableGroup.locator('.is-muted')).toHaveCount(0);

    await card.click();
    await expect(page).toHaveURL(/\/systems\/custom-image$/);
    // The visitor imports their own media: the launch stays blocked until then.
    await expect(page.getByText('Required media (provided by you)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start session' })).toBeDisabled();
  });
});

// Windows 10 x86 is standalone and validated: `ready` like Windows 7.
test.describe('Windows 10 x86 (standalone system)', () => {
  test('exposes a single `ready` card and opens the page', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Search for a system').fill('windows');

    const card = page.locator('.os-card[data-id="windows-10-x86"]');
    await expect(card).toHaveCount(1);
    // No phantom card anymore: the x64 variant does not exist.
    await expect(page.locator('.os-card[data-id="windows-10-x64"]')).toHaveCount(0);
    // Validated through the Windows 7 pipeline: advertised as "Available".
    await expect(card.locator('.card-status')).toHaveAttribute('data-state', 'ready');

    await card.click();
    await expect(page).toHaveURL(/\/systems\/windows-10-x86$/);
  });
});

// macOS Lion x64 is standalone and validated (v64 + OVMF + local OpenCore ESP);
// macOS Sequoia is still planned and stays in the pending group.
test.describe('macOS entries (Lion x64 available, Sequoia planned)', () => {
  test('exposes a ready Lion card and a planned Sequoia card', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'macOS' }).click();

    const lion = page.locator('.os-card[data-id="macos-lion-x64"]');
    await expect(lion).toHaveCount(1);
    await expect(lion.locator('.card-status')).toHaveAttribute('data-state', 'ready');
    await expect(lion.locator('.card-status')).toHaveText('Available');
    await expect(lion).not.toHaveClass(/is-muted/);

    const sequoia = page.locator('.os-card[data-id="macos-sequoia"]');
    await expect(sequoia).toHaveCount(1);
    await expect(sequoia.locator('.card-status')).toHaveAttribute('data-state', 'planned');
    await expect(sequoia).toHaveClass(/is-muted/);
    // The pending group is why the separator stays between the two groups.
    await expect(page.locator('.cards-separator')).toHaveCount(1);

    await lion.click();
    await expect(page).toHaveURL(/\/systems\/macos-lion-x64$/);
  });
});
