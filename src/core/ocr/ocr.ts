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
  type MangaOcrRecord,
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
//            worker is free; measured at ~250-420 pages/min on an M3 Pro
//            with WebGPU, depending on page density
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
  /** A crashed worker is terminated and replaced; late messages are ignored. */
  dead: boolean;
}

const MAX_ATTEMPTS = 2;
const urlParams = new URLSearchParams(location.search);
const ISOLATED = globalThis.crossOriginIsolated === true;
const CORES = navigator.hardwareConcurrency ?? 4;
const poolOverride = Number(urlParams.get("ocrPool"));
const threadsOverride = Number(urlParams.get("ocrThreads"));
const OCR_DEBUG = urlParams.has("ocrDebug");

/** Pool/threads topology, decided once the execution provider is known
    (workers are spawned in initPool). `?ocrPool=N` / `?ocrThreads=M` override
    for probes; `?ocrDebug=1` logs per-stage page timings. The split that
    matters is the execution provider:
      wasm EP, isolated — ONE worker with half the cores as wasm threads
        (P-cores). int8 GEMM is memory-bandwidth-bound, so extra workers only
        fight over the bus (measured on an M3 Pro, kaguya vol 1: single-thread
        ~830ms/block; 1×4 ~210; 1×6 ~148 ← sweet spot; 2×3 ~300, same
        throughput at 2× the memory; 1×8 ~255, E-cores stall the barriers).
      webgpu EP — a small POOL of workers, isolated or not. The detector and
        encoder run on the GPU and only the decoder is CPU, so separate
        workers overlap one page's CPU decode with the next page's GPU work.
        Measured on a 12-core M3 Pro, kny vol 1, BYTE-IDENTICAL output at
        every pool size. The initial sweep reached 1×6 ≈ 150, 2×3 ≈ 230,
        3×2 ≈ 248, 4×1 ≈ 277 pages/min; after detector reuse + selective
        decoder fetch: 4×1 ≈ 356, 5×1 ≈ 423, 6×1 ≈ 380. Five workers win on
        12+ cores; the sixth loses to contention. Threads stay at 1 — the GPU
        carries the encoder/detector and workers already parallelize the
        GEMM-bound decoder. Each worker is its OWN runtime instance with strictly
        serialized runs, so one runtime never runs two sessions at once —
        but a pool can still crash, which is exactly what the dead-worker
        replacement below is for.
      not isolated, wasm — no SharedArrayBuffer → one thread; a small pool of
        single-threaded workers is the fallback (3 on 8+ cores, else 2). */
function topology(ep: OcrEp): { pool: number; threads: number } {
  const pool =
    Number.isFinite(poolOverride) && poolOverride >= 1
      ? Math.min(6, Math.floor(poolOverride))
      : ep === "webgpu"
        ? CORES >= 12
          ? 5
          : Math.min(4, Math.max(2, Math.floor(CORES / 3)))
        : ISOLATED
          ? 1
          : CORES >= 8
            ? 3
            : 2;
  const threads =
    Number.isFinite(threadsOverride) && threadsOverride >= 1
      ? Math.min(8, Math.floor(threadsOverride))
      : ep === "webgpu"
        ? 1
        : ISOLATED
          ? Math.min(8, Math.max(1, Math.floor(CORES / 2)))
          : 1;
  return { pool, threads };
}

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
let pool: PoolWorker[] | null = null;
let filesPromise: Promise<OcrModelFiles> | null = null;
let modelFiles: OcrModelFiles | null = null;
/** Threads each pool worker was built with — a crash replacement reuses it. */
let workerThreads = 1;
/** Crash replacements are capped so a fundamentally broken runtime can't
    respawn workers forever. */
let crashReplacements = 0;
/** Execution provider decided at pool birth; workers build sessions from it. */
let ocrEp: OcrEp = "wasm";
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
function jobCurrent(job: Job): boolean {
  return !cancelled.has(job.bookId);
}

/** Every exit releases BOTH claims — busyPages and activeJobs. */
function releaseJob(job: Job): void {
  busyPages.delete(pageKey(job));
  activeJobs.delete(jobKey(job));
}

/** Bounded retry for a failed job: only a live book's job goes back
    (attempts < MAX); an exhausted job surfaces its error. Jobs for deleted
    books drop silently — the cancellation is permanent. */
function retryJob(job: Job, message: string): void {
  if (!jobCurrent(job)) return;
  job.attempts += 1;
  if (job.attempts < MAX_ATTEMPTS) {
    queue.unshift(job);
  } else {
    status.error = message;
  }
}

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

function spawnWorker(files: OcrModelFiles, threads: number): PoolWorker {
  const slot: PoolWorker = {
    worker: new Worker(new URL("./ocr.worker.ts", import.meta.url), {
      type: "module",
    }),
    state: "init",
    job: null,
    initAttempts: 1,
    dead: false,
  };
  const message: OcrWorkerIn = {
    type: "init",
    files,
    threads,
    ep: ocrEp,
    debug: OCR_DEBUG,
  };
  slot.worker.postMessage(message); // each worker gets its own copy
  slot.worker.onmessage = (event: MessageEvent<OcrWorkerOut>) =>
    onWorkerMessage(slot, event.data);
  slot.worker.onerror = (event) =>
    onWorkerCrash(slot, event.message || "worker crashed");
  return slot;
}

function onWorkerMessage(slot: PoolWorker, msg: OcrWorkerOut): void {
  if (slot.dead) return; // a replaced worker's last gasp — ignore
  if (msg.type === "ready") {
    slot.state = "idle";
    console.debug(`[ocr] worker ready (pool ${pool?.length ?? 0})`);
    void pump();
    return;
  }
  if (msg.type === "page") {
    const job = slot.job;
    if (job) releaseJob(job);
    slot.state = "idle";
    slot.job = null;
    console.debug(
      `[ocr] page ${msg.pageIndex} done by worker ${pool?.indexOf(slot) ?? "?"}`,
    );
    // A result for a deleted book is ignored for UI/progress and never
    // retried; its storage write was skipped anyway (deleteManga cascades,
    // and the atomic puts check the manga row).
    if (job && jobCurrent(job)) {
      for (const listener of pageListeners) {
        listener(msg.bookId, msg.pageIndex, msg.blocks);
      }
      notePageDone(msg.bookId, job.kind, msg.partial);
    }
    void pump();
    return;
  }
  // error: an in-flight job goes back (bounded), anything else just surfaces.
  if (slot.job) {
    const job = slot.job;
    releaseJob(job);
    slot.state = "idle";
    slot.job = null;
    console.warn(
      `[ocr] page ${job.pageIndex} failed (${job.attempts + 1}): ${msg.message}`,
    );
    retryJob(job, msg.message);
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
        threads: workerThreads,
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

/** Runtime-level crash (the Worker itself, not a reported job failure):
    release the page, bounded-retry the job, then replace the slot (capped,
    so a runtime that crashes on every init can't respawn forever). */
function onWorkerCrash(slot: PoolWorker, message: string): void {
  if (slot.dead) return;
  slot.dead = true;
  const job = slot.job;
  if (!job || jobCurrent(job)) status.error = message;
  console.warn("[ocr] worker crashed:", message);
  if (job) {
    slot.job = null;
    releaseJob(job);
    retryJob(job, message);
  }
  if (pool && modelFiles && crashReplacements < 8) {
    const index = pool.indexOf(slot);
    if (index >= 0) {
      crashReplacements += 1;
      try {
        slot.worker.terminate();
      } catch {
        // already gone
      }
      pool[index] = spawnWorker(modelFiles, workerThreads);
    }
  }
  emitStatus();
  void pump();
}

function initPool(files: OcrModelFiles): void {
  modelFiles = files;
  // The pool is born on the first successful download; later attempts reuse
  // the same resolved files promise, so this runs exactly once. The topology
  // depends on the execution provider decided just before (ocrEp).
  if (pool) return;
  const { pool: size, threads } = topology(ocrEp);
  workerThreads = threads;
  pool = Array.from({ length: size }, () => spawnWorker(files, threads));
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
    const slot = pool.find((slot) => slot.state === "idle" && !slot.dead);
    if (!slot) return;
    // Hovered blocks jump the queue; the rest stays FIFO (detect first,
    // then the recognition march in page order). A page never gets a second
    // active job — jobs for busy pages stay queued until the page releases.
    let jobIndex = queue.findIndex(
      (job) => job.kind === "block" && !busyPages.has(pageKey(job)),
    );
    if (jobIndex < 0) {
      jobIndex = queue.findIndex((job) => !busyPages.has(pageKey(job)));
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
    (or fully sidecar'd) volumes never enter the queue. The cancellation
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
