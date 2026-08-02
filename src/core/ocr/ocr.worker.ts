import { createOcrSessions, type OcrModels } from "./models";
import {
  detectPage,
  ocrPage,
  ocrPageFromSkeleton,
  recognizeBlock,
  setOcrDebugTiming,
} from "./pipeline";
import {
  loadMangaOcrPage,
  loadMangaPageBlob,
  mergeMangaOcrBlock,
  putMangaOcrDetect,
  putMangaOcrFinal,
} from "../storage";
import type { MokuroBlock } from "../mokuro";
import type { OcrModelFiles } from "./models";

// OCR worker, the EXECUTOR half of the pool: it holds warm model sessions
// (~130MB in its own heap — workers can't share memory) and processes one
// job per message. Scheduling, priorities and cancellation all live in the
// main-thread controller (ocr.ts); this file just reads a page blob, runs
// the pipeline, writes the result to the mangaOcr store and posts it back.
//
// Job kinds (lazy OCR):
//   detect — detector pass only, stores skeleton blocks (partial record)
//   run    — full page OCR, stores the final record
//   block  — recognize ONE block of a partial record (hover in the reader);
//            the updated page record is posted back whole, so the reader
//            repaints with the fresh text in place.

export type OcrWorkerIn =
  | {
      type: "init";
      files: OcrModelFiles;
      threads?: number;
      ep?: import("./ort-runtime").OcrEp;
      debug?: boolean;
    }
  | { type: "detect"; bookId: string; pageIndex: number }
  | { type: "run"; bookId: string; pageIndex: number }
  | {
      type: "block";
      bookId: string;
      pageIndex: number;
      blockIndex: number;
    };

export type OcrWorkerOut =
  | { type: "ready" }
  | {
      type: "page";
      bookId: string;
      pageIndex: number;
      blocks: MokuroBlock[];
      /** The record as stored: partial = skeleton (detect) or a page whose
          blocks aren't all recognized yet. Lets the scheduler count progress
          without re-reading the store after every page. */
      partial: boolean;
    }
  | { type: "error"; bookId?: string; pageIndex?: number; message: string };

let modelsPromise: Promise<OcrModels> | null = null;

const post = (msg: OcrWorkerOut): void => {
  (self as unknown as { postMessage(msg: OcrWorkerOut): void }).postMessage(msg);
};

async function pageBitmap(
  bookId: string,
  pageIndex: number,
): Promise<ImageBitmap | null> {
  const blob = await loadMangaPageBlob(bookId, pageIndex);
  // The volume left the library mid-queue — nothing to do here.
  return blob ? createImageBitmap(blob) : null;
}

async function runJob(
  msg: Exclude<OcrWorkerIn, { type: "init" }>,
): Promise<void> {
  if (!modelsPromise) throw new Error("worker not initialized");
  const models = await modelsPromise;
  const bitmap = await pageBitmap(msg.bookId, msg.pageIndex);
  if (!bitmap) {
    post({
      type: "page",
      bookId: msg.bookId,
      pageIndex: msg.pageIndex,
      blocks: [],
      partial: true,
    });
    return;
  }
  try {
    if (msg.type === "detect") {
      const { blocks, crops } = await detectPage(models, bitmap);
      // Atomic at the storage boundary: skipped when the volume is gone or
      // a full run already wrote a final record (never downgrade a final).
      const written = await putMangaOcrDetect(
        msg.bookId,
        msg.pageIndex,
        blocks,
        crops,
      );
      if (written) {
        post({
          type: "page",
          bookId: msg.bookId,
          pageIndex: msg.pageIndex,
          blocks,
          partial: true,
        });
        return;
      }
      const existing = await loadMangaOcrPage(msg.bookId, msg.pageIndex);
      post({
        type: "page",
        bookId: msg.bookId,
        pageIndex: msg.pageIndex,
        blocks: existing?.blocks ?? [],
        partial: existing ? !!existing.partial : true,
      });
      return;
    }
    if (msg.type === "block") {
      const record = await loadMangaOcrPage(msg.bookId, msg.pageIndex);
      const target = record?.blocks[msg.blockIndex];
      if (record && target) {
        const filled = await recognizeBlock(models, bitmap, target);
        if (filled) {
          // Atomic merge: folds THIS block into the current record inside one
          // transaction, so a concurrent fill of another block on the same
          // page is never clobbered (no read-outside/write-later lost update).
          const merged = await mergeMangaOcrBlock(
            msg.bookId,
            msg.pageIndex,
            msg.blockIndex,
            filled,
          );
          if (merged) {
            post({
              type: "page",
              bookId: msg.bookId,
              pageIndex: msg.pageIndex,
              blocks: merged.blocks,
              partial: !!merged.partial,
            });
            return;
          }
        }
      }
      // No skeleton to fill (already recognized or gone) — report as-is.
      post({
        type: "page",
        bookId: msg.bookId,
        pageIndex: msg.pageIndex,
        blocks: record?.blocks ?? [],
        partial: record ? !!record.partial : true,
      });
      return;
    }
    // Full page recognition. Reuse the stored skeleton's exact float crops
    // when present — no second detector pass, blocks identical to a full
    // detect. Legacy rounded skeletons (no crops) fall back to full
    // detect+recognize; a record already final is left untouched.
    const existing = await loadMangaOcrPage(msg.bookId, msg.pageIndex);
    if (existing && !existing.partial) {
      post({
        type: "page",
        bookId: msg.bookId,
        pageIndex: msg.pageIndex,
        blocks: existing.blocks,
        partial: false,
      });
      return;
    }
    const crops = existing?.crops;
    const blocks =
      crops &&
      crops.length === existing.blocks.length &&
      crops.every(
        (crop) => crop.length === 4 && crop.every(Number.isFinite),
      )
      ? await ocrPageFromSkeleton(models, bitmap, crops, msg.pageIndex)
      : await ocrPage(models, bitmap, msg.pageIndex);
    await putMangaOcrFinal(msg.bookId, msg.pageIndex, blocks);
    post({
      type: "page",
      bookId: msg.bookId,
      pageIndex: msg.pageIndex,
      blocks,
      partial: false,
    });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (event: MessageEvent<OcrWorkerIn>) => {
  const msg = event.data;
  if (msg.type === "init") {
    setOcrDebugTiming(msg.debug === true);
    const init = createOcrSessions(
      msg.files,
      msg.threads ?? 1,
      msg.ep ?? "wasm",
    );
    modelsPromise = init;
    // Two-argument then: ready or error posts exactly once and the rejection
    // is handled in-place — no rethrow (an unhandled rejection), no parked
    // promise. Both handlers act only while THIS init is still the active
    // modelsPromise, so a replaced init never posts stale or nulls the live
    // promise. Jobs only arrive after "ready", so runJob's `await
    // modelsPromise` never sees a rejection.
    void init.then(
      () => {
        if (modelsPromise !== init) return;
        post({ type: "ready" });
      },
      (err: unknown) => {
        if (modelsPromise !== init) return;
        modelsPromise = null;
        post({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return;
  }
  void runJob(msg).catch((err: unknown) => {
    post({
      type: "error",
      bookId: msg.bookId,
      pageIndex: msg.pageIndex,
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
