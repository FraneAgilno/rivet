import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('conference program is visible and has no automatically detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Build your conference day' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(4);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
