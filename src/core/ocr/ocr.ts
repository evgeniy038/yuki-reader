import {
  loadManga,
  loadMangaOcrFlags,
  loadMangaOcrPage,
  loadShelfBooks,
  type MangaOcrRecord,
} from "../storage";
import { ensureFiles, pool } from "./pool";
import { emitBooks, emitStatus, notePageDone, status, trackedBooks } from "./progress";
import type { OcrWorkerIn } from "./ocr.worker";

// Main-thread handle for the OCR pool — the SCHEDULER half. It owns the page
// queue (priorities, cancellation, retries); the worker pool it feeds lives
// in pool.ts, the progress listeners it reports to in progress.ts. Model
// files are downloaded once (with progress) and every worker gets its own
// copy of the bytes plus one page job at a time. Workers spawn lazily on the
// first sidecar-less book and stay warm for the session.
//
// Every manga volume needing OCR goes through the same pipeline:
//   detect — boxes for every page (fast; a volume stays gated on the shelf
//            until all its pages have skeletons)
//   march  — recognize pages in order, after every queued detect job,
//            whenever a worker is free; measured at ~230-420 pages/min on
//            an M3 Pro with WebGPU, depending on page density
//   hover  — a single block, always ahead of everything (recognizeBlockNow)
// The listener sets feed the UI: status → model download + errors, books →
// the per-volume queue panel (counts come from storage, never from queue
// length), page → a live reader attaching fresh overlays.

export type { OcrBookProgress, OcrStatus } from "./progress";
export { onOcrBooks, onOcrPage, onOcrStatus } from "./progress";

export interface Job {
  bookId: string;
  pageIndex: number;
  attempts: number;
  /** detect = skeletons (cheap), run = full page, block = one hovered block. */
  kind: "detect" | "run" | "block";
  blockIndex?: number;
}

const MAX_ATTEMPTS = 2;

const queue: Job[] = [];
/** Deleted book UUIDs — cancelled permanently for this module's lifetime.
    Book ids are crypto.randomUUID() (contentHash is only duplicate
    metadata), so an id is never reused: a re-import of the same archive is
    a NEW id that never collides with a cancelled one. */
const cancelled = new Set<string>();
/** Page ownership: at most ONE active job per page regardless of kind. */
const busyPages = new Set<string>();
/** Exact claimed jobs (jobKey): queue/track dedupe. */
const activeJobs = new Set<string>();
let pumping = false;
let pumpAgain = false;

function pageKey(job: Job): string {
  return `${job.bookId}/${job.pageIndex}`;
}

/** Exact job identity — the queue/activeJobs key. */
function jobKey(job: Job): string {
  return job.kind === "block"
    ? `${pageKey(job)}/block/${job.blockIndex ?? 0}`
    : `${pageKey(job)}/${job.kind}`;
}

/** The job's book is still alive (not deleted since the job was queued). */
export function jobCurrent(job: Job): boolean {
  return !cancelled.has(job.bookId);
}

/** Every exit releases BOTH claims — busyPages and activeJobs. */
export function releaseJob(job: Job): void {
  busyPages.delete(pageKey(job));
  activeJobs.delete(jobKey(job));
}

/** Bounded retry for a failed job: only a live book's job goes back
    (attempts < MAX); an exhausted job surfaces its error. Jobs for deleted
    books drop silently — the cancellation is permanent. */
export function retryJob(job: Job, message: string): void {
  if (!jobCurrent(job)) return;
  job.attempts += 1;
  if (job.attempts < MAX_ATTEMPTS) {
    queue.unshift(job);
  } else {
    status.error = message;
  }
}

// --- scheduling ---------------------------------------------------------------

async function dispatch(): Promise<void> {
  while (pool && queue.length > 0) {
    const slot = pool.find((slot) => slot.state === "idle" && !slot.dead);
    if (!slot) return;
    // Hovered blocks jump the queue, then every volume's detect pass, then
    // the recognition march — each FIFO. Detect before ANY march: a batch
    // import lifts every volume's gate in detect time instead of waiting
    // for the volumes queued ahead of it to be fully recognized. A page
    // never gets a second active job — jobs for busy pages stay queued
    // until the page releases.
    let jobIndex = -1;
    for (const kind of ["block", "detect", "run"] as const) {
      jobIndex = queue.findIndex(
        (job) => job.kind === kind && !busyPages.has(pageKey(job)),
      );
      if (jobIndex >= 0) break;
    }
    // Every queued page is busy — keep the jobs, wait for a release.
    if (jobIndex < 0) return;
    const job = queue.splice(jobIndex, 1)[0]!;
    if (!jobCurrent(job)) continue;
    // Claim the page AND the exact job BEFORE the storage read: a concurrent
    // track/enqueue can neither start a second job on this page nor queue a
    // copy of this one while we decide whether it still needs work.
    busyPages.add(pageKey(job));
    activeJobs.add(jobKey(job));
    // Skip pages done earlier (another tab, a previous session): a detect
    // job is done by ANY current record, a run only by a recognized one,
    // a block only when its lines are already filled.
    let record: MangaOcrRecord | undefined;
    try {
      record = await loadMangaOcrPage(job.bookId, job.pageIndex);
    } catch (err) {
      // No busy page may survive a storage exception: release both claims,
      // bounded-retry (the error surfaces after MAX_ATTEMPTS, never spins).
      releaseJob(job);
      retryJob(job, err instanceof Error ? err.message : String(err));
      emitStatus();
      continue;
    }
    const done =
      (job.kind === "detect" && !!record) ||
      (job.kind === "run" && !!record && !record.partial) ||
      (job.kind === "block" &&
        !!record?.blocks[job.blockIndex ?? -1]?.lines.length);
    if (done || !jobCurrent(job)) {
      releaseJob(job);
      // Count a storage-skipped page for a live job (another tab or an
      // earlier session did the work) so progress still converges.
      if (done && jobCurrent(job)) {
        notePageDone(job.bookId, job.kind, !!record?.partial);
      }
      continue;
    }
    if (slot.dead) {
      // The worker crashed during the storage read — its replacement holds
      // the pool index, this slot is inert. Hand the page back and requeue;
      // the crash handler's pump re-dispatches.
      releaseJob(job);
      queue.unshift(job);
      return;
    }
    slot.state = "busy";
    slot.job = job;
    const message: OcrWorkerIn =
      job.kind === "block"
        ? {
            type: "block",
            bookId: job.bookId,
            pageIndex: job.pageIndex,
            blockIndex: job.blockIndex ?? 0,
          }
        : {
            type: job.kind,
            bookId: job.bookId,
            pageIndex: job.pageIndex,
          };
    slot.worker.postMessage(message);
  }
}

export async function pump(): Promise<void> {
  if (queue.length === 0) return;
  if (pumping) {
    pumpAgain = true;
    return;
  }
  pumping = true;
  try {
    ensureFiles(); // download runs ahead of the pool becoming ready
    do {
      pumpAgain = false;
      await dispatch();
    } while (pumpAgain);
  } finally {
    pumping = false;
  }
}

// --- public API -----------------------------------------------------------------

function enqueue(bookId: string, pages: number[], kind: "detect" | "run"): void {
  if (pages.length === 0) return;
  // A cancelled UUID is dead forever — never revived (ids are random and
  // never reused; a re-import tracks under a fresh id).
  if (cancelled.has(bookId)) return;
  status.error = null;
  for (const pageIndex of pages) {
    const job: Job = { bookId, pageIndex, attempts: 0, kind };
    const key = jobKey(job);
    // Exact-identity dedupe: skip a queued or active copy.
    if (queue.some((queued) => jobKey(queued) === key)) continue;
    if (activeJobs.has(key)) continue;
    queue.push(job);
  }
  void pump();
  emitStatus();
}

/** Detect-only skeletons for pages without a sidecar (the reader mounts this
    as a safety net — imports and resumeMangaOcr normally beat it to it). */
export function enqueueDetect(bookId: string, pages: number[]): void {
  enqueue(bookId, pages, "detect");
}

/** Register a volume with the OCR pipeline: count its sidecar-less pages from
    storage, queue detect for the unboxed, then the recognition march — every
    remaining page in order, at the back of the queue, so the volume finishes
    on its own without ever blocking the reader. Idempotent; fully recognized
    (or fully sidecar'd) volumes never enter the queue, and neither do
    volumes received from another device. The cancellation
    guards bracket the storage reads: imports call this from a putMangaVolume
    `.then`, so a delete can land before or during the reads — neither may
    resurrect a tracked row or a queue for a dead UUID. */
export async function trackMangaOcr(bookId: string): Promise<void> {
  if (cancelled.has(bookId)) return;
  const [manga, flags] = await Promise.all([
    loadManga(bookId),
    loadMangaOcrFlags(bookId),
  ]);
  // Second guard, and nothing below awaits: a delete can no longer interleave
  // between this check and the tracked/queue mutations.
  if (cancelled.has(bookId)) return;
  // A volume that came from another device is recognized THERE: its text
  // arrives with it, or later through sync — never a second pass here.
  if (!manga || manga.received) return;
  const needing = manga.pages.flatMap((meta, index) =>
    meta.blocks && meta.blocks.length > 0 ? [] : [index],
  );
  if (needing.length === 0) return;
  const undetected: number[] = [];
  const unrecognized: number[] = [];
  for (const index of needing) {
    if (!flags.has(index)) undetected.push(index);
    if (flags.get(index) !== true) unrecognized.push(index);
  }
  if (unrecognized.length === 0) return;
  const existing = trackedBooks.get(bookId);
  if (existing?.doneTimer) window.clearTimeout(existing.doneTimer);
  trackedBooks.set(bookId, {
    total: needing.length,
    detected: needing.length - undetected.length,
    recognized: needing.length - unrecognized.length,
    doneTimer: null,
  });
  enqueue(bookId, undetected, "detect");
  enqueue(bookId, unrecognized, "run");
  emitBooks();
}

let resumed = false;
/** Rebuild the march after a reload: every unfinished manga volume in the
    library re-registers in shelf order (the queue died with the page — the
    results in storage did not). */
export function resumeMangaOcr(): void {
  if (resumed) return;
  resumed = true;
  void loadShelfBooks().then(async (records) => {
    for (const record of records) {
      if (record.format === "manga") await trackMangaOcr(record.id);
    }
  });
}

/** Recognize ONE hovered block as soon as a worker frees up. */
export function recognizeBlockNow(
  bookId: string,
  pageIndex: number,
  blockIndex: number,
): void {
  // A cancelled UUID is dead forever — see enqueue.
  if (cancelled.has(bookId)) return;
  status.error = null;
  const job: Job = { bookId, pageIndex, attempts: 0, kind: "block", blockIndex };
  const key = jobKey(job);
  // Exact-identity dedupe — see enqueue.
  if (queue.some((queued) => jobKey(queued) === key)) return;
  if (activeJobs.has(key)) return;
  queue.unshift(job);
  void pump();
  emitStatus();
}

/** A volume left the library: cancel its UUID permanently (ids are random
    and never reused — a re-import gets a fresh one). Drops everything
    queued and tracked. Still-active jobs keep their page claim until
    result/error/crash arrives and release it as usual, but get no UI, no
    progress and no retry; their storage write is skipped too (deleteManga
    cascades the OCR store, and the atomic puts check the manga row). */
export function cancelOcr(bookId: string): void {
  cancelled.add(bookId);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.bookId === bookId) queue.splice(i, 1);
  }
  const tracked = trackedBooks.get(bookId);
  if (tracked?.doneTimer) window.clearTimeout(tracked.doneTimer);
  if (trackedBooks.delete(bookId)) emitBooks();
  emitStatus();
}
