import { applyBookDelta, type DailyStats } from "../stats";
import { loadShelfBooks, putStatsDay, restoreBookProgress } from "../storage";
import { BackupCancelledError, type BackupCancelToken, type BackupOperationProgressListener } from "../backup";
import type { BackupImportSummary } from "./import";
import { readJson } from "./format";

interface TtsuProgressData {
  progress?: number | string;
  lastBookmarkModified?: number;
}

interface TtsuStatistic {
  title?: string;
  dateKey?: string;
  charactersRead?: number;
  readingTime?: number;
}

function titleKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function ttsuTitle(path: string): string {
  const segment = path.split("/")[0] ?? path;
  try {
    return decodeURIComponent(segment)
      .replaceAll("~ttu-star~", "*")
      .replaceAll("~ttu-dend~", ".")
      .replaceAll("~ttu-spc~", " ");
  } catch {
    return segment;
  }
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export async function importTtsuBackup(
  files: Record<string, Uint8Array>,
  onProgress?: BackupOperationProgressListener,
  token?: BackupCancelToken,
): Promise<BackupImportSummary> {
  const progressPaths = Object.keys(files).filter((path) =>
    /(?:^|\/)progress_[^/]+\.json$/i.test(path),
  );
  const statisticsPaths = Object.keys(files).filter((path) =>
    /(?:^|\/)statistics_[^/]+\.json$/i.test(path),
  );
  if (progressPaths.length === 0 && statisticsPaths.length === 0) {
    throw new Error("Unsupported progress file");
  }

  // Parse everything before writing anything: a corrupt file must abort the
  // import before the library changes at all, never halfway through.
  const progressOps: {
    key: string;
    progress: number;
    lastReadAt?: number;
  }[] = [];
  for (const path of progressPaths) {
    const data = readJson<TtsuProgressData>(files, path);
    const rawProgress = finiteNumber(data.progress);
    if (rawProgress === undefined) continue;
    const lastReadAt = finiteNumber(data.lastBookmarkModified);
    progressOps.push({
      key: titleKey(ttsuTitle(path)),
      progress: rawProgress > 1 ? rawProgress / 100 : rawProgress,
      ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    });
  }

  const dayRows: {
    dateKey: string;
    chars: number;
    timeMs: number;
    titleKey?: string;
  }[] = [];
  for (const path of statisticsPaths) {
    const raw = readJson<unknown>(files, path);
    const rows = Array.isArray(raw) ? raw : [raw];
    for (const value of rows) {
      if (!value || typeof value !== "object") continue;
      const row = value as TtsuStatistic;
      if (!row.dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(row.dateKey)) continue;
      dayRows.push({
        dateKey: row.dateKey,
        chars: Math.max(0, finiteNumber(row.charactersRead) ?? 0),
        timeMs: Math.max(0, (finiteNumber(row.readingTime) ?? 0) * 1000),
        ...(row.title ? { titleKey: titleKey(row.title) } : {}),
      });
    }
  }

  const books = await loadShelfBooks();
  const booksByTitle = new Map(books.map((book) => [titleKey(book.title), book]));
  const summary: BackupImportSummary = {
    books: 0,
    progress: 0,
    stats: 0,
    dictionaries: 0,
  };
  const total = Math.max(1, progressOps.length + dayRows.length);
  let completed = 0;
  onProgress?.({ phase: "restore", current: completed, total });

  for (const op of progressOps) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    const target = booksByTitle.get(op.key);
    if (target) {
      await restoreBookProgress(target.id, op.progress, op.lastReadAt);
      summary.progress += 1;
    }
    completed += 1;
    onProgress?.({ phase: "restore", current: completed, total });
  }

  const days = new Map<string, DailyStats>();
  for (const row of dayRows) {
    const day = days.get(row.dateKey) ?? {
      date: row.dateKey,
      chars: 0,
      pages: 0,
      timeMs: 0,
    };
    day.chars += row.chars;
    day.timeMs += row.timeMs;
    let next = day;
    if (row.titleKey) {
      const target = booksByTitle.get(row.titleKey);
      if (target) {
        next = applyBookDelta(next, target.id, {
          chars: row.chars,
          timeMs: row.timeMs,
        });
      }
    }
    days.set(row.dateKey, next);
    completed += 1;
    onProgress?.({ phase: "restore", current: completed, total });
  }
  for (const day of days.values()) {
    if (token?.cancelled) throw new BackupCancelledError(summary);
    await putStatsDay(day);
    summary.stats += 1;
  }
  onProgress?.({ phase: "restore", current: total, total });
  return summary;
}
