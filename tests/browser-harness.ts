// Shared scaffold for the browser smokes: the dev-server guard (reuse a
// server already on the base URL, or spawn `pnpm dev` and wait) and the
// standard headless Chrome launch (1280×800). Smokes with a special setup —
// headed mode, another viewport, an env-configured base, a persistent
// profile — keep their own local versions.
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
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { browser, context, page };
}
