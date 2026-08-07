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

// Leaving a reader: the chrome auto-hides after 1s idle and wakes ONLY from
// the top REVEAL_ZONE_PX (10) strip — the check is `clientY < 10`, so moving
// to y=10 itself never wakes it and the click falls through to the page (a
// page turn). Throw the cursor to y=5, then wait until the pill actually
// takes the hit at the button's point: opacity-0 still reads as "visible" to
// the selector engine, so only a real hit-test proves the chrome is awake.
export async function exitToShelf(page: Page): Promise<void> {
  await page.mouse.move(640, 5);
  await page.waitForFunction(
    () => {
      const button = document.querySelector(
        'button[aria-label="Back to the shelf"]',
      );
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      return button.contains(
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
      );
    },
    undefined,
    { timeout: 5_000 },
  );
  await page.click('button[aria-label="Back to the shelf"]');
  await page.waitForSelector("[data-book-id]", { timeout: 10_000 });
  await page.waitForTimeout(500);
}
