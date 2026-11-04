// Shared scaffold for the browser smokes: the dev-server guard (reuse a
// server already on the base URL, or spawn `pnpm dev` and wait) and the
// standard headless Chromium launch (1280×800). Smokes with a special setup —
// headed mode, another viewport, an env-configured base, a persistent
// profile — keep their own local versions.
//
// Every smoke launches Playwright's own Chromium (`channel: "chromium"`, set
// up by `node node_modules/playwright-core/cli.js install chromium --no-shell`),
// never the system Chrome: each system-Chrome launch copies the 1.4 GB app
// into a code-sign clone under /var/folders, and a killed run leaks it.
import { spawn } from "node:child_process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

export async function ensureServer(
  base = "http://localhost:1420",
): Promise<void> {
  const up = await fetch(base).then(
    (r) => r.ok,
    () => false,
  );
  if (up) return;
  const child = spawn("pnpm", ["dev"], {
    cwd: process.cwd(),
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const ok = await fetch(base).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
  }
  throw new Error(`dev server did not come up on ${base}`);
}

export async function launchBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// Clicking a button on the auto-hiding reader chrome (the top pill). The pill
// hides after ~1s idle and wakes ONLY from the top REVEAL_ZONE_PX (10) strip —
// the app's check is `clientY < 10`, so a wake at y=10 itself never fires and
// the click falls through to the page. Throw the cursor to y=5, then hit-test
// the button's own point: an opacity-0 pill still reads as "visible" to the
// selector engine, so only elementFromPoint proves the chrome is awake.
export async function clickChromeButton(
  page: Page,
  selector: string,
): Promise<void> {
  await page.mouse.move(720, 5);
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return el.contains(
        document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        ),
      );
    },
    selector,
    { timeout: 5_000 },
  );
  await page.click(selector);
}
