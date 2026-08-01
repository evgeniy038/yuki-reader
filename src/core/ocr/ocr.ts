import type { MokuroBlock } from "../mokuro";
import {
  detectPreferredEp,
  downloadModelFiles,
  type OcrModelFiles,
} from "./models";
import type { OcrEp } from "./ort-runtime";
import {
  loadAllBooks,
  loadManga,
  loadMangaOcrFlags,
  loadMangaOcrPage,
} from "../storage";
import type { OcrWorkerIn, OcrWorkerOut } from "./ocr.worker";

// Main-thread handle for the OCR pool — the SCHEDULER half. It owns the page
// queue (priorities, cancellation, retries), downloads the model files once
// (with progress) and hands every worker its own copy of the bytes plus one
// page job at a time. Workers spawn lazily on the first sidecar-less book
// and stay warm for the session.
//
// Every manga volume needing OCR goes through the same pipeline:
//   detect — boxes for every page (fast; a volume stays gated on the shelf
//            until all its pages have skeletons)
//   march  — recognize pages in order, at the back of the queue, whenever a
//            worker is free; a volume finishes on its own in a few minutes
//            (~60-70 pages/min measured on an M3 Pro with WebGPU)
//   hover  — a single block, always ahead of everything (recognizeBlockNow)
// The listener sets feed the UI: status → model download + errors, books →
// the per-volume queue panel (counts come from storage, never from queue
// length), page → a live reader attaching fresh overlays.

export interface OcrStatus {
  /** Model download in flight: bytes so far / total (0 until headers). */
  models: { loaded: number; total: number } | null;
  /** Last error (kept visible until the queue moves again). */
  error: string | null;
}

export type OcrBookStage = "detect" | "recognize" | "done";

/** One volume's OCR progress — storage truth, per stage. */
export interface OcrBookProgress {
  bookId: string;
  stage: OcrBookStage;
  /** Pages done in the CURRENT stage (detected, or recognized). */
  done: number;
  /** Pages needing OCR at all (sidecar-less). */
  total: number;
}

type StatusListener = (status: OcrStatus) => void;
type BookListener = (books: OcrBookProgress[]) => void;
type PageListener = (
  bookId: string,
  pageIndex: number,
  blocks: MokuroBlock[],
) => void;

interface Job {
  bookId: string;
  pageIndex: number;
  attempts: number;
  /** detect = skeletons (cheap), run = full page, block = one hovered block. */
  kind: "detect" | "run" | "block";
  blockIndex?: number;
}

interface PoolWorker {
  worker: Worker;
  /** init = sessions building, idle/busy = pool duty. */
  state: "init" | "idle" | "busy";
  job: Job | null;
  /** Session rebuilds are retried once per worker. */
  initAttempts: number;
}

const MAX_ATTEMPTS = 2;
// Pool/threads topology for the WASM EP, measured on an M3 Pro (12 cores:
// 6P+6E), kaguya volume 1, per-block encoder time as the metric (on WebGPU
// hosts the detector + encoder run on the GPU instead — see models.ts —
// and the march measures ~60-70 pages/min):
//   single-thread wasm:   ~830ms/block            (any pool — workers starve)
//   1 worker × 4 threads: ~210ms → 12 pages/min
//   1 worker × 6 threads: ~148ms → 16.5 pages/min  ← sweet spot
//   2 workers × 3 thr:    ~300ms → 16.5 pages/min (same, 2× the memory)
//   1 worker × 8 threads: ~255ms → 9 pages/min    (E-cores stall the barriers)
// So: when cross-origin isolated, ONE worker with half the cores as wasm
// threads (P-cores); int8 GEMM is memory-bandwidth-bound, so extra workers
// only fight over the bus. Without SharedArrayBuffer (no COOP/COEP on the
// host) threads are impossible — then a small pool of single-threaded
// workers is the fallback (~10 pages/min). `?ocrPool=N` / `?ocrThreads=M`
// override for probes; `?ocrDebug=1` logs per-stage page timings.
const urlParams = new URLSearchParams(location.search);
const ISOLATED = globalThis.crossOriginIsolated === true;
const CORES = navigator.hardwareConcurrency ?? 4;
const poolOverride = Number(urlParams.get("ocrPool"));
const POOL_SIZE =
  Number.isFinite(poolOverride) && poolOverride >= 1
    ? Math.min(4, Math.floor(poolOverride))
    : ISOLATED
      ? 1
      : CORES >= 8
        ? 3
        : 2;
const threadsOverride = Number(urlParams.get("ocrThreads"));
const WORKER_THREADS =
  Number.isFinite(threadsOverride) && threadsOverride >= 1
    ? Math.min(8, Math.floor(threadsOverride))
    : ISOLATED
      ? Math.min(8, Math.max(1, Math.floor(CORES / 2)))
      : 1;
const OCR_DEBUG = urlParams.has("ocrDebug");

const queue: Job[] = [];
const cancelled = new Set<string>();
let pool: PoolWorker[] | null = null;
let filesPromise: Promise<OcrModelFiles> | null = null;
let modelFiles: OcrModelFiles | null = null;
/** Execution provider decided at pool birth; workers build sessions from it. */
let ocrEp: OcrEp = "wasm";
let pumping = false;
let pumpAgain = false;

const status: OcrStatus = { models: null, error: null };
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
const trackedBooks = new Map<string, TrackedBook>();

function emitStatus(): void {
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

function emitBooks(): void {
  const list = currentBooks();
  for (const listener of bookListeners) listener(list);
}

/** Count a completed page against its volume's progress. The worker reports
    the record's final partial flag, so this is pure arithmetic — no store
    re-read per page. Registration seeded the counters from storage and every
    later mutation arrives through this path (single tab), so they can't
    drift; a page counted twice by a worker race is clamped at `total`. When
    the count says the volume is finished, one storage recount verifies it
    before the "done" row shows. */
function notePageDone(bookId: string, kind: Job["kind"] | null, partial: boolean): void {
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
async function verifyDone(bookId: string, tracked: TrackedBook): Promise<void> {
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

// --- pool -------------------------------------------------------------------

function spawnWorker(files: OcrModelFiles): PoolWorker {
  const slot: PoolWorker = {
    worker: new Worker(new URL("./ocr.worker.ts", import.meta.url), {
      type: "module",
    }),
    state: "init",
    job: null,
    initAttempts: 1,
  };
  const message: OcrWorkerIn = {
    type: "init",
    files,
    threads: WORKER_THREADS,
    ep: ocrEp,
    debug: OCR_DEBUG,
  };
  slot.worker.postMessage(message); // each worker gets its own copy
  slot.worker.onmessage = (event: MessageEvent<OcrWorkerOut>) =>
    onWorkerMessage(slot, event.data);
  slot.worker.onerror = (event) => {
    status.error = event.message || "worker crashed";
    console.warn("[ocr] worker crashed:", status.error);
    emitStatus();
  };
  return slot;
}

function onWorkerMessage(slot: PoolWorker, msg: OcrWorkerOut): void {
  if (msg.type === "ready") {
    slot.state = "idle";
    console.debug(`[ocr] worker ready (pool ${pool?.length ?? 0})`);
    void pump();
    return;
  }
  if (msg.type === "page") {
    const doneBookId = msg.bookId;
    const doneKind = slot.job?.kind ?? null;
    slot.state = "idle";
    slot.job = null;
    console.debug(
      `[ocr] page ${msg.pageIndex} done by worker ${pool?.indexOf(slot) ?? "?"}`,
    );
    if (!cancelled.has(doneBookId)) {
      for (const listener of pageListeners) {
        listener(msg.bookId, msg.pageIndex, msg.blocks);
      }
      notePageDone(doneBookId, doneKind, msg.partial);
    }
    void pump();
    return;
  }
  // error: an in-flight job goes back (bounded), anything else just surfaces.
  if (slot.job) {
    const job = slot.job;
    slot.state = "idle";
    slot.job = null;
    job.attempts += 1;
    console.warn(`[ocr] page ${job.pageIndex} failed (${job.attempts}): ${msg.message}`);
    if (job.attempts < MAX_ATTEMPTS) {
      queue.unshift(job);
    } else {
      status.error = msg.message;
    }
  } else {
    // Session build failed — re-initialize this worker once, then give up
    // (the pool just runs one short).
    status.error = msg.message;
    console.warn(`[ocr] worker init failed (attempt ${slot.initAttempts}): ${msg.message}`);
    if (modelFiles && slot.state === "init" && slot.initAttempts < 2) {
      slot.initAttempts += 1;
      slot.worker.postMessage({
        type: "init",
        files: modelFiles,
        threads: WORKER_THREADS,
        ep: ocrEp,
        debug: OCR_DEBUG,
      });
      emitStatus();
      return;
    }
  }
  emitStatus();
  void pump();
}

function initPool(files: OcrModelFiles): void {
  modelFiles = files;
  // The pool is born on the first successful download; later attempts reuse
  // the same resolved files promise, so this runs exactly once.
  pool ??= Array.from({ length: POOL_SIZE }, () => spawnWorker(files));
}

// --- scheduling ---------------------------------------------------------------

function ensureFiles(): Promise<OcrModelFiles> {
  filesPromise ??= detectPreferredEp()
    .then((ep) => {
      ocrEp = ep;
      return downloadModelFiles(ep, (loaded, total) => {
        status.models = { loaded, total };
        emitStatus();
      });
    })
    .then((files) => {
      status.models = null;
      emitStatus();
      initPool(files);
      return files;
    });
  filesPromise.catch(() => {
    // Retry-friendly: the next enqueue restarts the download.
    filesPromise = null;
    status.models = null;
    status.error = "model download failed";
    emitStatus();
  });
  return filesPromise;
}

async function dispatch(): Promise<void> {
  while (pool && queue.length > 0) {
    const slot = pool.find((slot) => slot.state === "idle");
    if (!slot) return;
    // Hovered blocks jump the queue; the rest stays FIFO (detect first,
    // then the recognition march in page order).
    const blockJobIndex = queue.findIndex((job) => job.kind === "block");
    const job = queue.splice(blockJobIndex >= 0 ? blockJobIndex : 0, 1)[0]!;
    if (cancelled.has(job.bookId)) continue;
    // Skip pages done earlier (another tab, a previous session): a detect
    // job is done by ANY current record, a run only by a recognized one,
    // a block only when its lines are already filled.
    const record = await loadMangaOcrPage(job.bookId, job.pageIndex);
    if (job.kind === "detect" && record) continue;
    if (job.kind === "run" && record && !record.partial) continue;
    if (
      job.kind === "block" &&
      record?.blocks[job.blockIndex ?? -1]?.lines.length
    )
      continue;
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

async function pump(): Promise<void> {
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
  status.error = null;
  cancelled.delete(bookId);
  for (const pageIndex of pages) {
    if (
      queue.some(
        (job) =>
          job.bookId === bookId && job.pageIndex === pageIndex && job.kind === kind,
      )
    ) {
      continue;
    }
    queue.push({ bookId, pageIndex, attempts: 0, kind });
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
    (or fully sidecar'd) volumes never enter the queue. */
export async function trackMangaOcr(bookId: string): Promise<void> {
  const [manga, flags] = await Promise.all([
    loadManga(bookId),
    loadMangaOcrFlags(bookId),
  ]);
  if (!manga) return;
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
  void loadAllBooks().then(async (records) => {
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
  status.error = null;
  cancelled.delete(bookId);
  if (
    queue.some(
      (job) =>
        job.bookId === bookId &&
        job.pageIndex === pageIndex &&
        job.kind === "block" &&
        job.blockIndex === blockIndex,
    )
  ) {
    return;
  }
  queue.unshift({ bookId, pageIndex, attempts: 0, kind: "block", blockIndex });
  void pump();
  emitStatus();
}

/** Drop everything queued for a volume (it left the library). In-flight
    results are discarded on arrival. */
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
