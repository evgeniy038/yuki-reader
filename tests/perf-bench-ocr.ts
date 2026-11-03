// OCR and backup scenarios of the speed benchmark (see tests/perf-bench.ts).
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { requireEnv } from "./env.ts";
import {
  BASE,
  bookInput,
  goShelf,
  mangaFixtures,
  realFiles,
  results,
  session,
  tempProfile,
} from "./perf-harness.ts";
import { longTasks, now, round, storeCounts, until, untilStored } from "./perf-probes.ts";

async function ocrCounts(page: Page): Promise<{ records: number; final: number }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const all = await new Promise<{ partial?: boolean }[]>((resolve) => {
      const req = db.transaction("mangaOcr").objectStore("mangaOcr").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    db.close();
    return { records: all.length, final: all.filter((r) => r && !r.partial).length };
  });
}

export async function ocr(): Promise<void> {
  const f = await mangaFixtures();
  const profile = process.env.YUKI_BENCH_PROFILE_DIR ?? tempProfile();
  const s = await session(profile);
  const { page } = s;
  await goShelf(page);
  const warm = ((await storeCounts(page)).ocrModels ?? 0) >= 4;
  // YUKI_BENCH_OCR_VOL=kimetsu for a second volume (default: kaguya zip).
  const volume = process.env.YUKI_BENCH_OCR_VOL === "kimetsu" ? f.kimetsu : f.kaguya;
  const t0 = await now(page);
  await page.setInputFiles('input[accept*=".mokuro"]', [volume]);
  await until(page, "tiles", 1);
  const pages = await page.evaluate(async () => {
    for (;;) {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open("yuki");
        req.onsuccess = () => resolve(req.result);
      });
      const records = await new Promise<{ pages: unknown[] }[]>((resolve) => {
        const req = db.transaction("manga").objectStore("manga").getAll();
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      if (records[0]) return records[0].pages.length;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  const models = await untilStored(page, "ocrModels", 4, 600_000);
  let detected = 0;
  let firstFinal = 0;
  for (;;) {
    const c = await ocrCounts(page);
    if (!detected && c.records >= pages) detected = await now(page);
    if (!firstFinal && c.final > 0) firstFinal = await now(page);
    if (c.final >= pages) break;
    await page.waitForTimeout(250);
  }
  const done = await now(page);
  results.ocr = {
    warmModels: warm,
    pages,
    modelsMs: round(models - t0),
    detectDoneMs: round(detected - t0),
    firstPageMs: round(firstFinal - t0),
    allDoneMs: round(done - t0),
    recognizePagesPerMin: Math.round((pages / ((done - detected) / 60_000)) * 10) / 10,
    blocked: await longTasks(page, t0, done),
  };
  // YUKI_BENCH_OCR_DUMP=file: every page's boxes + text, for A/B diffs of
  // pipeline changes (page index → blocks; the book id is random per run).
  const dump = process.env.YUKI_BENCH_OCR_DUMP;
  if (dump) {
    const records = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open("yuki");
        req.onsuccess = () => resolve(req.result);
      });
      const store = db.transaction("mangaOcr").objectStore("mangaOcr");
      const [keys, values] = await Promise.all([
        new Promise<IDBValidKey[]>((r) => {
          const req = store.getAllKeys();
          req.onsuccess = () => r(req.result);
        }),
        new Promise<{ blocks: { box: number[]; lines: string[] }[] }[]>((r) => {
          const req = store.getAll();
          req.onsuccess = () => r(req.result);
        }),
      ]);
      db.close();
      const out: Record<string, { box: number[]; lines: string[] }[]> = {};
      keys.forEach((key, i) => {
        const index = String(key).slice(String(key).lastIndexOf("/") + 1);
        out[index] = (values[i]?.blocks ?? []).map((b) => ({ box: b.box, lines: b.lines }));
      });
      return out;
    });
    writeFileSync(dump, JSON.stringify(records));
  }
  // Leave the model cache warm for the next run, drop everything else.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("yuki");
      req.onsuccess = () => resolve(req.result);
    });
    const names = [...db.objectStoreNames].filter((n) => n !== "ocrModels");
    const tx = db.transaction(names, "readwrite");
    for (const name of names) tx.objectStore(name).clear();
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  });
  await s.context.close();
}

export async function backup(): Promise<void> {
  const dir = requireEnv("YUKI_TEST_EPUB_DIR");
  const books = realFiles(dir, /\.epub$/i);
  const f = await mangaFixtures();
  const s = await session(tempProfile());
  const { page } = s;
  await s.context.route("**/ocr-models/**", (route) => route.abort());
  await goShelf(page);
  await page.setInputFiles(bookInput, books);
  await untilStored(page, "books", books.length, 300_000);
  await page.setInputFiles('input[accept*=".mokuro"]', [f.kimetsu]);
  await untilStored(page, "manga", 1, 300_000);
  const download = page.waitForEvent("download", { timeout: 600_000 });
  const exported = await page.evaluate(async () => {
    const m = await import("/src/core/backup.ts");
    const t0 = performance.now();
    const blob: Blob = await m.exportBackupTask().promise;
    const ms = performance.now() - t0;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bench-backup.zip";
    a.click();
    return { ms, size: blob.size };
  });
  // The download artifact itself is the file to restore (no second copy).
  const file = await (await download).path();
  // Restore into a fresh origin ([::1] ≠ localhost: an empty database).
  const fresh = await s.context.newPage();
  await fresh.goto(BASE.replace("localhost", "[::1]"));
  await fresh.waitForTimeout(800);
  await fresh.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "bench-file";
    document.body.append(input);
  });
  await fresh.setInputFiles("#bench-file", file);
  const imported = await fresh.evaluate(async () => {
    const m = await import("/src/core/backup.ts");
    const input = document.querySelector<HTMLInputElement>("#bench-file")!;
    const t0 = performance.now();
    await m.importBackupTask(input.files![0]!).promise;
    return performance.now() - t0;
  });
  results.backup = {
    books: books.length + 1,
    exportMs: round(exported.ms),
    sizeMB: Math.round(exported.size / 1048576),
    importMs: round(imported),
  };
  await s.context.close();
}
