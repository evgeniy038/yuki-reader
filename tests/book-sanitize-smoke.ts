// Hostile-EPUB regression: a book's chapter HTML must never run code in the
// app. The fixture is built on the fly — a chapter armed with every vector
// that survived the old <script>-only strip (img onerror, details ontoggle,
// SVG animate onbegin, a javascript: link, an iframe srcdoc) plus a remote
// tracking pixel, next to an ordinary inline image that must keep rendering.
// Import → open → nothing fired, nothing dangerous left in the live DOM.
// With YUKI_TEST_EXPECT_CSP=1 (a production build: `pnpm build && pnpm
// preview`) it also proves the meta CSP blocks an inline handler on its own.
// Usage: pnpm tsx tests/book-sanitize-smoke.ts   (YUKI_TEST_BASE to retarget)

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { chromium } from "playwright-core";
import { ensureServer } from "./browser-harness.ts";
import { openFreshTile } from "./import-open.ts";

const BASE = process.env.YUKI_TEST_BASE ?? "http://localhost:1420";
const EXPECT_CSP = process.env.YUKI_TEST_EXPECT_CSP === "1";

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const PWN = "window.__pwn=(window.__pwn||0)+1";
const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>罠</title></head><body>
<p>本文テスト。ここは普通の段落です。</p>
<p><img id="local" src="pic.png" alt="ok"/></p>
<p><img id="evil-img" src="missing.png" onerror="${PWN}"/></p>
<details open="open" ontoggle="${PWN}"><summary>s</summary>d</details>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"><animate onbegin="${PWN}" attributeName="x" dur="1s"/></rect></svg>
<p><a id="jslink" href="javascript:${PWN}">link</a></p>
<iframe srcdoc="&lt;script&gt;parent.__pwn=1&lt;/script&gt;"></iframe>
<p><img id="remote" src="https://example.invalid/pixel.gif"/></p>
</body></html>`;

function hostileEpub(): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`,
    ),
    "content.opf": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>罠の本</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="pic.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    ),
    "ch1.xhtml": strToU8(chapter),
    "pic.png": PNG_1x1,
  });
}

async function main(): Promise<void> {
  if (BASE === "http://localhost:1420") await ensureServer(BASE);
  else if (!(await fetch(BASE).then((r) => r.ok, () => false)))
    throw new Error(`nothing answers on ${BASE}`);

  const dir = mkdtempSync(join(tmpdir(), "yuki-hostile-"));
  const epubPath = join(dir, "hostile.epub");
  writeFileSync(epubPath, hostileEpub());

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.setInputFiles('input[accept*="epub"]', epubPath);
    await openFreshTile(page, ".book-content");
    await page.waitForTimeout(1_500); // images settle, details toggles, SMIL begins

    const dom = await page.evaluate(() => {
      const root = document.querySelector(".book-content")!;
      const handlers = Array.from(root.querySelectorAll("*")).filter((el) =>
        Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith("on")),
      ).length;
      return {
        pwn: (window as unknown as { __pwn?: number }).__pwn ?? 0,
        text: root.textContent?.includes("本文テスト") ?? false,
        iframes: root.querySelectorAll("iframe").length,
        animates: root.querySelectorAll("animate").length,
        handlers,
        jsHref: root.querySelector("#jslink")?.getAttribute("href") ?? null,
        remoteSrc: root.querySelector("#remote")?.getAttribute("src") ?? null,
        localSrc: root.querySelector("#local")?.getAttribute("src") ?? "",
      };
    });
    check(dom.text, "the chapter text renders");
    check(dom.localSrc.startsWith("blob:"), `the book's own image still renders (${dom.localSrc.slice(0, 12)}…)`);
    check(dom.pwn === 0, `no handler ran (count ${dom.pwn})`);
    check(dom.handlers === 0, "no on* attribute reached the live DOM");
    check(dom.iframes === 0, "the iframe is gone");
    check(dom.animates === 0, "SVG animation is gone");
    check(dom.jsHref === null, "the javascript: link lost its href");
    check(dom.remoteSrc === null, "the remote tracking pixel lost its src");

    await page.locator("#jslink").evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(300);
    const afterClick = await page.evaluate(
      () => (window as unknown as { __pwn?: number }).__pwn ?? 0,
    );
    check(afterClick === 0, "tapping the defanged link runs nothing");

    if (EXPECT_CSP) {
      const csp = await page.evaluate(async () => {
        const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        let violations = 0;
        document.addEventListener("securitypolicyviolation", () => (violations += 1));
        document.body.insertAdjacentHTML(
          "beforeend",
          '<img src="x" onerror="window.__csp=1">',
        );
        await new Promise((r) => setTimeout(r, 800));
        return {
          meta: meta !== null,
          ran: (window as unknown as { __csp?: number }).__csp === 1,
          violations,
        };
      });
      check(csp.meta, "the build ships the CSP meta tag");
      check(!csp.ran && csp.violations > 0, "CSP alone blocks an inline handler");
    } else {
      console.log("  · CSP not expected here (dev server); run against a build with YUKI_TEST_EXPECT_CSP=1");
    }
    await context.close();
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nbook sanitize smoke: all good");
}

await main();
