import type { Page } from "playwright-core";

// Imports stay on the shelf (batch import doesn't auto-open the reader), so
// after setInputFiles a smoke opens the fresh book through its tile — the
// freshest import leads the recency sort.
export async function openFreshTile(
  page: Page,
  readerSelector: string,
): Promise<void> {
  await page.waitForSelector("[data-book-id]", { timeout: 60_000 });
  await page.locator("[data-book-id]").first().click();
  await page.waitForSelector(readerSelector, { timeout: 60_000 });
}
