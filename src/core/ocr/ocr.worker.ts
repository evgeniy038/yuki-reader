import { createOcrSessions, type OcrModels } from "./models";
import {
  detectPage,
  ocrPage,
  recognizeBlock,
  setOcrDebugTiming,
} from "./pipeline";
import { loadMangaOcrPage, loadMangaPageBlob, putMangaOcr } from "../storage";
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
      const blocks = await detectPage(models, bitmap);
      // A full "run" of the same page may have finished on another worker
      // while this detect was in flight — a skeleton must never overwrite
      // a final record.
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
      await putMangaOcr(msg.bookId, msg.pageIndex, blocks, true);
      post({
        type: "page",
        bookId: msg.bookId,
        pageIndex: msg.pageIndex,
        blocks,
        partial: true,
      });
      return;
    }
    if (msg.type === "block") {
      const record = await loadMangaOcrPage(msg.bookId, msg.pageIndex);
      const target = record?.blocks[msg.blockIndex];
      if (record && target) {
        const filled = await recognizeBlock(models, bitmap, target);
        if (filled) {
          record.blocks[msg.blockIndex] = filled;
          const done = record.blocks.every((block) => block.lines.length > 0);
          await putMangaOcr(msg.bookId, msg.pageIndex, record.blocks, !done);
          post({
            type: "page",
            bookId: msg.bookId,
            pageIndex: msg.pageIndex,
            blocks: record.blocks,
            partial: !done,
          });
          return;
        }
      }
      // No skeleton to fill (already recognized or gone) — report as-is.
      post({
        type: "page",
        bookId: msg.bookId,
        pageIndex: msg.pageIndex,
        blocks: record?.blocks ?? [],
        partial: record?.partial ?? true,
      });
      return;
    }
    const blocks = await ocrPage(models, bitmap, msg.pageIndex);
    await putMangaOcr(msg.bookId, msg.pageIndex, blocks);
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
    modelsPromise = createOcrSessions(msg.files, msg.threads ?? 1, msg.ep ?? "wasm")
      .then((models) => {
        post({ type: "ready" });
        return models;
      })
      .catch((err: unknown) => {
        modelsPromise = null;
        post({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      });
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
