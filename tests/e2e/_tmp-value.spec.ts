import { expect, test } from '@playwright/test';

test('toHaveValue regexp partial', async ({ page }) => {
  await page.setContent('<textarea id="t"></textarea>');
  await page.evaluate(() => {
    (document.getElementById('t') as HTMLTextAreaElement).value = 'aaa\n__X__\nbbb';
  });
  const t = page.locator('#t');
  await expect(t).toHaveValue(/__X__/);
  await expect(t).toHaveValue(/\n__X__\n/);
  await expect(t).toHaveValue(/\n__X__\r?\n/);
});
