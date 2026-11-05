import { detectPreferredEp } from "./models";
import { cacheModelFiles, type OcrModelRefs } from "./download";
import type { OcrEp } from "./ort-runtime";
import { ocrTopology } from "./topology";
import type { OcrWorkerIn, OcrWorkerOut } from "./ocr.worker";
import { jobCurrent, pump, releaseJob, retryJob, type Job } from "./ocr";
import { emitPage, emitStatus, notePageDone, status } from "./progress";

// The worker-pool half of the OCR scheduler: worker spawn, message/crash
// handling and the one-time model download that births the pool
// (ensureFiles; its size comes from topology.ts). The page queue it drains
// lives in ocr.ts; the progress it reports lives in progress.ts.

export interface PoolWorker {
  worker: Worker;
  /** init = sessions building, idle/busy = pool duty. */
  state: "init" | "idle" | "busy";
  job: Job | null;
  /** Session rebuilds are retried once per worker. */
  initAttempts: number;
  /** A crashed worker is terminated and replaced; late messages are ignored. */
  dead: boolean;
}

const urlParams = new URLSearchParams(location.search);
const ISOLATED = globalThis.crossOriginIsolated === true;
const CORES = navigator.hardwareConcurrency ?? 4;
const poolOverride = Number(urlParams.get("ocrPool"));
const threadsOverride = Number(urlParams.get("ocrThreads"));
/** `?ocrDebug=1` logs per-stage page timings. */
const OCR_DEBUG = urlParams.has("ocrDebug");
/** A phone or a tablet: one worker (see ocrTopology). */
const TOUCH = globalThis.matchMedia?.("(pointer: coarse)").matches === true;

export let pool: PoolWorker[] | null = null;
let filesPromise: Promise<OcrModelRefs> | null = null;
/** Where workers read the model files from (the cache, by URL). */
let modelFiles: OcrModelRefs | null = null;
/** Threads each pool worker was built with — a crash replacement reuses it. */
let workerThreads = 1;
/** Crash replacements are capped so a fundamentally broken runtime can't
    respawn workers forever. */
let crashReplacements = 0;
/** Execution provider decided at pool birth; workers build sessions from it. */
let ocrEp: OcrEp = "wasm";

// --- pool -------------------------------------------------------------------

function spawnWorker(files: OcrModelRefs, threads: number): PoolWorker {
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
  slot.worker.postMessage(message); // each worker reads its own copy
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
      emitPage(msg.bookId, msg.pageIndex, msg.blocks);
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

function initPool(files: OcrModelRefs): void {
  modelFiles = files;
  // The pool is born on the first successful download; later attempts reuse
  // the same resolved files promise, so this runs exactly once. The topology
  // depends on the execution provider decided just before (ocrEp).
  if (pool) return;
  const { pool: size, threads } = ocrTopology({
    ep: ocrEp,
    cores: CORES,
    isolated: ISOLATED,
    touch: TOUCH,
    poolOverride,
    threadsOverride,
  });
  workerThreads = threads;
  pool = Array.from({ length: size }, () => spawnWorker(files, threads));
}

// --- model download -----------------------------------------------------------

export function ensureFiles(): Promise<OcrModelRefs> {
  filesPromise ??= detectPreferredEp()
    .then((ep) => {
      ocrEp = ep;
      return cacheModelFiles(ep, (loaded, total) => {
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
