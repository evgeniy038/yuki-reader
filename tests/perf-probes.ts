// In-page timing probes for the speed benchmark (tests/perf-bench.ts).
// Every duration is measured INSIDE the page with performance.now(): a
// condition is polled every animation frame and stamped the moment it
// holds, so CDP round-trips never leak into the numbers. Long tasks (main
// thread blocked > 50ms) are collected from the first script on, keystrokes
// are stamped in the capture phase — a page turn is "key → turned page".
import type { BrowserContext, CDPSession, Page } from "playwright-core";

interface PerfState {
  longtasks: [number, number][];
  lastKeyAt: number;
  hit: number;
}

declare global {
  interface Window {
    __perf: PerfState;
  }
}

const INIT = `(() => {
  const perf = { longtasks: [], lastKeyAt: 0, hit: 0 };
  window.__perf = perf;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.longtasks.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  addEventListener("keydown", () => { perf.lastKeyAt = performance.now(); }, true);
})();`;

export async function installProbes(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: INIT });
}

export const now = (page: Page): Promise<number> =>
  page.evaluate(() => performance.now());

/** Named DOM conditions, evaluated in the page. */
const CONDITIONS = {
  /** At least `arg` tiles on screen. */
  tiles: (arg: number) => document.querySelectorAll("[data-book-id]").length >= arg,
  /** A tile whose text contains `arg`. */
  tile: (arg: string) =>
    [...document.querySelectorAll("[data-book-id]")].some((el) =>
      (el.textContent ?? "").includes(arg),
    ),
  /** The text reader shows a section with a measured indicator. */
  epubOpen: () =>
    !!document.querySelector(".book-content section[data-chapter]") &&
    /\d+ \/ \d+ \d/.test(
      document.querySelector("[data-page-indicator]")?.textContent ?? "",
    ),
  /** The text reader's page signature differs from `arg`. */
  epubTurned: (arg: string) => {
    const content = document.querySelector(".reading");
    const scroll = content?.parentElement;
    const section =
      document.querySelector(".book-content section")?.getAttribute("data-chapter") ?? "";
    return !!scroll && `${section}|${scroll.scrollTop}|${scroll.scrollLeft}` !== arg;
  },
  /** The manga reader shows page `arg` (0 = any) with every image decoded. */
  mangaPage: (arg: number) => {
    const set = document.querySelector("[data-manga-page]");
    if (!set) return false;
    if (arg > 0 && set.getAttribute("data-manga-page") !== String(arg)) return false;
    const imgs = [...set.querySelectorAll("img")];
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  },
  /** The PDF reader painted a page canvas. */
  pdfPage: () =>
    [...document.querySelectorAll("canvas")].some((c) => c.width > 0 && c.height > 0),
  /** No OCR-gated (frosted) tile is left. */
  ungated: () => !document.querySelector("[data-ocr-gated]"),
} as const;

export type ConditionName = keyof typeof CONDITIONS;

/** Wait for a named condition; resolves with the in-page time it first held. */
export async function until(
  page: Page,
  name: ConditionName,
  arg: unknown = 0,
  timeout = 120_000,
): Promise<number> {
  const source = CONDITIONS[name].toString();
  await page.waitForFunction(
    ({ source, arg }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${source})`)() as (a: unknown) => boolean;
      if (!fn(arg)) return false;
      window.__perf.hit = performance.now();
      return true;
    },
    { source, arg },
    { polling: "raf", timeout },
  );
  return page.evaluate(() => window.__perf.hit);
}

/** Current page signature of the text reader (see epubTurned). */
export const epubSignature = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const scroll = document.querySelector(".reading")?.parentElement;
    const section =
      document.querySelector(".book-content section")?.getAttribute("data-chapter") ?? "";
    return scroll ? `${section}|${scroll.scrollTop}|${scroll.scrollLeft}` : "";
  });

export const lastKeyAt = (page: Page): Promise<number> =>
  page.evaluate(() => window.__perf.lastKeyAt);

/** Long tasks that STARTED inside [from, to]: total blocked ms and the worst. */
export async function longTasks(
  page: Page,
  from: number,
  to: number,
): Promise<{ total: number; max: number; count: number }> {
  return page.evaluate(
    ({ from, to }) => {
      let total = 0;
      let max = 0;
      let count = 0;
      for (const [start, duration] of window.__perf.longtasks) {
        if (start < from || start > to) continue;
        total += duration;
        max = Math.max(max, duration);
        count += 1;
      }
      return { total: Math.round(total), max: Math.round(max), count };
    },
    { from, to },
  );
}

/** Record counts per IndexedDB store of the app database. */
export async function storeCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const out: Record<string, number> = {};
    for (const name of [...db.objectStoreNames]) {
      out[name] = await new Promise<number>((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    db.close();
    return out;
  });
}

/** Poll storage until `store` holds at least `count` records; in-page time. */
export async function untilStored(
  page: Page,
  store: string,
  count: number,
  timeout = 300_000,
): Promise<number> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const counts = await storeCounts(page).catch(() => ({}) as Record<string, number>);
    if ((counts[store] ?? 0) >= count) return now(page);
    if (Date.now() > deadline) throw new Error(`timeout: ${store} < ${count}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** JS heap after a forced GC (V8 heap only) + the UA's own total (heap,
    DOM, ArrayBuffers) where measureUserAgentSpecificMemory is available. */
export async function memory(
  page: Page,
  cdp: CDPSession | null,
): Promise<{ heapMB: number | null; totalMB: number | null }> {
  if (!cdp) return { heapMB: null, totalMB: null };
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  const total = await page.evaluate(async () => {
    const perf = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (!perf.measureUserAgentSpecificMemory || !crossOriginIsolated) return null;
    const result = await Promise.race([
      perf.measureUserAgentSpecificMemory(),
      new Promise<null>((r) => setTimeout(() => r(null), 30_000)),
    ]);
    return result ? result.bytes : null;
  });
  const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;
  return { heapMB: mb(usedSize), totalMB: total === null ? null : mb(total) };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export const round = (n: number): number => Math.round(n);
