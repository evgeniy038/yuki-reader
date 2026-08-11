import type { Page } from "playwright-core";
import { clickChromeButton } from "./browser-harness.ts";

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

// Leaving a reader: the chrome pill auto-hides — clickChromeButton wakes it
// with a hit-tested top-edge throw, then the shelf selector confirms the exit.
export async function exitToShelf(page: Page): Promise<void> {
  await clickChromeButton(page, 'button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
}
