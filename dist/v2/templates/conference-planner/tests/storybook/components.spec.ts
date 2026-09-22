import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const story = (id: string) => `/iframe.html?id=${id}&viewMode=story`;
const accessibility = (page: Page) => new AxeBuilder({ page })
  .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);

test.describe('conference component stories', () => {
  test('every documented component state meets the WCAG gate', async ({ page }) => {
    const storyIds = [
      'components-button--default',
      'components-button--hover',
      'components-button--focus',
      'components-button--pressed',
      'components-button--disabled',
      'components-button--loading',
      'components-sessioncard--default',
      'components-sessioncard--selected',
      'components-sessioncard--disabled',
      'components-sessioncard--loading',
      'components-sessioncard--success',
      'components-sessioncard--error',
      'components-sessioncard--hover',
      'components-sessioncard--focus',
      'components-sessioncard--content-boundary',
      'components-sessioncard--desktop',
      'components-conflictdialog--default',
      'components-conflictdialog--resolving',
      'components-conflictdialog--content-boundary',
      'components-conflictdialog--desktop',
    ];

    for (const storyId of storyIds) {
      await test.step(storyId, async () => {
        await page.goto(story(storyId));
        expect((await accessibility(page).analyze()).violations).toEqual([]);
      });
    }
  });

  test('Button stories are accessible and support keyboard interaction', async ({ page }) => {
    await page.goto(story('components-button--focus'));
    const button = page.getByRole('button', { name: 'Add to agenda' });
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('data-activated', 'true');
    expect((await accessibility(page).analyze()).violations).toEqual([]);
  });

  test('SessionCard preserves content at mobile and desktop boundaries', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(story('components-sessioncard--content-boundary'));
    const card = page.getByRole('article');
    const title = page.getByRole('heading', { level: 3 });
    await expect(title).toContainText('intentionally long');
    await expect(card).toHaveCSS('flex-direction', 'column');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(card).toHaveCSS('flex-direction', 'row');
    expect((await accessibility(page).analyze()).violations).toEqual([]);
  });

  test('ConflictDialog exposes conflict details and contains keyboard focus', async ({ page }) => {
    await page.goto(story('components-conflictdialog--default'));
    const dialog = page.getByRole('dialog', { name: 'Schedule conflict' });
    await expect(dialog).toContainText('Runtime guardrails that fail closed');
    await expect(dialog).toContainText('Evidence-led design reviews');
    await expect(page.getByRole('button', { name: 'Keep current agenda' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Replace conflict/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Keep current agenda' })).toBeFocused();
    expect((await accessibility(page).analyze()).violations).toEqual([]);
  });
});
