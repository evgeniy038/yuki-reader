import type { MokuroBlock } from "../mokuro";
import { loadMangaOcrFlags } from "../storage";
import type { Job } from "./ocr";

// The progress half of the OCR scheduler: the status/books/page listener
// sets the UI subscribes to, and the per-volume counters fed by completed
// page jobs (counts converge to storage truth — verifyDone recounts before
// the "done" row shows). The queue and the worker pool live in ocr.ts and
// pool.ts.

export interface OcrStatus {
  /** Model download in flight: bytes so far / total (0 until headers). */
  models: { loaded: number; total: number } | null;
  /** Last error (kept visible until the queue moves again). */
  error: string | null;
}

type OcrBookStage = "detect" | "recognize" | "done";

/** One volume's OCR progress — storage truth, per stage. */
export interface OcrBookProgress {
  bookId: string;
  stage: OcrBookStage;
  /** Pages done in the CURRENT stage (detected, or recognized). */
  done: number;
  /** Pages needing OCR at all (sidecar-less). */
  total: number;
}

export type StatusListener = (status: OcrStatus) => void;
export type BookListener = (books: OcrBookProgress[]) => void;
export type PageListener = (
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
) => void;

export const status: OcrStatus = { models: null, error: null };
const statusListeners = new Set<StatusListener>();
const bookListeners = new Set<BookListener>();
const pageListeners = new Set<PageListener>();

/** Volumes with OCR in flight, in registration order (= queue order). */
interface TrackedBook {
  total: number;
  detected: number;
  recognized: number;
  /** A finished volume lingers a few seconds so the panel shows the check. */
  doneTimer: number | null;
}
export const trackedBooks = new Map<string, TrackedBook>();

export function emitStatus(): void {
  for (const listener of statusListeners) listener({ ...status });
}

function currentBooks(): OcrBookProgress[] {
  return [...trackedBooks.entries()].map(([bookId, tracked]) => ({
    bookId,
    stage:
      tracked.detected < tracked.total
        ? "detect"
        : tracked.recognized < tracked.total
          ? "recognize"
          : "done",
    done:
      tracked.detected < tracked.total ? tracked.detected : tracked.recognized,
    total: tracked.total,
  }));
}

export function emitBooks(): void {
  const list = currentBooks();
  for (const listener of bookListeners) listener(list);
}

export function emitPage(
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
): void {
  for (const listener of pageListeners) listener(bookId, pageIndex, blocks);
}

/** Count a completed page against its volume's progress. The worker reports
    the record's final partial flag, so this is pure arithmetic — no store
    re-read per page. Registration seeded the counters from storage and every
    later mutation arrives through this path (single tab), so they can't
    drift; a page counted twice by a worker race is clamped at `total`. When
    the count says the volume is finished, one storage recount verifies it
    before the "done" row shows. */
export function notePageDone(bookId: string, kind: Job["kind"] | null, partial: boolean): void {
  const tracked = trackedBooks.get(bookId);
  if (!tracked || tracked.doneTimer !== null) return;
  if (kind === "detect") {
    tracked.detected = Math.min(tracked.total, tracked.detected + 1);
  }
  if (!partial) {
    tracked.recognized = Math.min(tracked.total, tracked.recognized + 1);
    tracked.detected = Math.max(tracked.detected, tracked.recognized);
  }
  if (tracked.recognized >= tracked.total) void verifyDone(bookId, tracked);
  emitBooks();
}

/** The one storage recount per volume: confirm "done" before the check shows
    (counters could have over-counted through a worker race); if it doesn't
    hold, the real counts replace the drifted ones. */
export async function verifyDone(bookId: string, tracked: TrackedBook): Promise<void> {
  const flags = await loadMangaOcrFlags(bookId);
  let recognized = 0;
  for (const done of flags.values()) if (done) recognized += 1;
  if (trackedBooks.get(bookId) !== tracked || tracked.doneTimer !== null) {
    return;
  }
  if (recognized < tracked.total) {
    tracked.detected = Math.min(tracked.total, flags.size);
    tracked.recognized = recognized;
    emitBooks();
    return;
  }
  tracked.doneTimer = window.setTimeout(() => {
    trackedBooks.delete(bookId);
    emitBooks();
  }, 4000);
}

export function onOcrStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  listener({ ...status });
  return () => statusListeners.delete(listener);
}

export function onOcrBooks(listener: BookListener): () => void {
  bookListeners.add(listener);
  listener(currentBooks());
  return () => bookListeners.delete(listener);
}

export function onOcrPage(listener: PageListener): () => void {
  pageListeners.add(listener);
  return () => pageListeners.delete(listener);
}
