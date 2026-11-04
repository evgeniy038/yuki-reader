import { ort, type Tensor } from "./ort-runtime";
import type { MokuroBlock } from "../mokuro";
import type { OcrModels } from "./models";
import { decodeBlocks, type OcrTiming } from "./decode";
import {
  blockLuma,
  chwPixels,
  cropRect,
  detBlock,
  detectOrdered,
  type Det,
} from "./detect";
import { splitLines } from "./lines";

// The OCR pipeline proper: ogkalu comic-text-and-bubble-detector at 640²
// finds text blocks (detect.ts) → a block too dense to read whole is split
// into its lines (lines.ts) → each crop (padded, NOT rotated — manga-ocr reads
// vertical text natively) goes through the manga-ocr vision encoder at
// 224² and a greedy char-WordPiece decoder (decode.ts). This file keeps the
// recognize march — crops, batched encode/decode, the page entry points —
// and re-exports the detect pass, so consumers keep importing ./pipeline.

export { detectPage } from "./detect";

const CROP_SIZE = 224;

let debugTiming = false;
export function setOcrDebugTiming(on: boolean): void {
  debugTiming = on;
}

/** Recognize the text of one previously detected block (hover-triggered
    lazy OCR) — the same read as the march, so a hovered block and a
    marched one never differ. Returns null when the crop reads as empty. */
export async function recognizeBlock(
  models: OcrModels,
  bitmap: ImageBitmap,
  block: MokuroBlock,
): Promise<MokuroBlock | null> {
  const [x1, y1, x2, y2] = block.box;
  const det: Det = { x1, y1, x2, y2, cls: 1, conf: 1 };
  const [read] = await recognizeDets(models, bitmap, [det], {
    crop: 0,
    enc: 0,
    dec: 0,
  });
  if (!read) return null;
  return {
    ...block,
    vertical: read.vertical,
    font_size: read.font_size,
    lines: read.lines,
  };
}

/** Blocks per encode+decode round. The decoder is the page's wall (~2/3 of
    block time), and its cost is run overhead, not GEMM size — so lockstep
    batches amortize it. 4 keeps the wasted tail short: a batch decodes until
    its LONGEST row finishes. */
const BLOCK_BATCH = 4;

/** One batched encoder pass over 224² crops; returns last_hidden_state
    [B, seq, dim] (the caller disposes). */
async function encodeBatch(
  models: OcrModels,
  pxList: Float32Array[],
  timing: OcrTiming,
): Promise<Tensor> {
  const plane = 3 * CROP_SIZE * CROP_SIZE;
  const data = new Float32Array(pxList.length * plane);
  for (let i = 0; i < pxList.length; i++) data.set(pxList[i]!, i * plane);
  const t0 = performance.now();
  const input = new ort.Tensor("float32", data, [
    pxList.length,
    3,
    CROP_SIZE,
    CROP_SIZE,
  ]);
  const encOut = await models.encoder.run({ pixel_values: input });
  input.dispose();
  timing.enc += performance.now() - t0;
  return encOut.last_hidden_state!;
}

/** How one block is read: its whole padded crop, or line by line — each
    line one or more chunks whose texts concatenate. */
interface ReadPlan {
  det: Det;
  vertical: boolean;
  lines: { sx: number; sy: number; sw: number; sh: number }[][];
}

/** A dense block reads line by line: at 224² a block of many columns
    leaves each glyph a sliver of the encoder's input, a line alone gets
    the whole crop (lines.ts decides when that pays). Every other block
    keeps its padded whole-block crop. */
function planRead(bitmap: ImageBitmap, det: Det): ReadPlan {
  const vertical = det.y2 - det.y1 > (det.x2 - det.x1) * 1.2;
  const region = blockLuma(bitmap, det);
  const split = region ? splitLines(region.gray, vertical) : null;
  if (region && split) {
    const lines = split.lines.map((chunks) =>
      chunks.flatMap((c) => {
        const sx = Math.max(0, Math.round(region.left + c.x1));
        const sy = Math.max(0, Math.round(region.top + c.y1));
        const sw = Math.min(bitmap.width, Math.round(region.left + c.x2)) - sx;
        const sh = Math.min(bitmap.height, Math.round(region.top + c.y2)) - sy;
        return sw >= 4 && sh >= 4 ? [{ sx, sy, sw, sh }] : [];
      }),
    );
    return { det, vertical: split.vertical, lines };
  }
  const rect = cropRect(det, bitmap.width, bitmap.height);
  return { det, vertical, lines: rect ? [[rect]] : [] };
}

/** Read a list of detections: plan each block (whole crop or its lines),
    encode AND decode every crop in batches of BLOCK_BATCH, return
    overlay-ready blocks in input order (empty reads dropped). The batched
    decode is the point — batching only the encoder with a per-block decode
    measured a net loss (the GPU sync wait just moved into the dec phase).
    Shared by ocrPage, ocrPageFromSkeleton and recognizeBlock so identical
    rects give identical blocks. Strictly SEQUENTIAL: onnxruntime-web
    crashes when two sessions run concurrently in one runtime instance
    (OrtRun "__next_prime overflow"). */
async function recognizeDets(
  models: OcrModels,
  bitmap: ImageBitmap,
  dets: Det[],
  timing: OcrTiming,
): Promise<MokuroBlock[]> {
  const t0 = performance.now();
  const plans = dets.map((det) => planRead(bitmap, det));
  const crops: { plan: number; line: number; px: Float32Array }[] = [];
  plans.forEach((plan, p) =>
    plan.lines.forEach((chunks, line) => {
      for (const r of chunks) {
        crops.push({
          plan: p,
          line,
          px: chwPixels(bitmap, r.sx, r.sy, r.sw, r.sh, CROP_SIZE, true),
        });
      }
    }),
  );
  timing.crop += performance.now() - t0;
  const texts: string[] = [];
  for (let start = 0; start < crops.length; start += BLOCK_BATCH) {
    const batch = crops.slice(start, start + BLOCK_BATCH);
    const hidden = await encodeBatch(
      models,
      batch.map(({ px }) => px),
      timing,
    );
    texts.push(...(await decodeBlocks(models, hidden, timing)));
    hidden.dispose();
  }
  const lineTexts = plans.map((plan) => plan.lines.map(() => ""));
  crops.forEach((crop, i) => {
    lineTexts[crop.plan]![crop.line] += texts[i] ?? "";
  });
  const blocks: MokuroBlock[] = [];
  plans.forEach((plan, p) => {
    const lines = lineTexts[p]!.filter(Boolean);
    if (lines.length > 0) blocks.push(detBlock(plan.det, lines, plan.vertical));
  });
  return blocks;
}

function logPageTiming(
  pageIndex: number | undefined,
  totalMs: number,
  detectMs: number,
  blocks: number,
  blocksMs: number,
  timing: OcrTiming,
): void {
  console.debug(
    `[ocr-page] #${pageIndex ?? "?"} total ${totalMs.toFixed(0)}ms | ` +
      `detect ${detectMs.toFixed(0)} | blocks ${blocks} in ${blocksMs.toFixed(0)} ` +
      `(crop ${timing.crop.toFixed(0)}, enc ${timing.enc.toFixed(0)}, dec ${timing.dec.toFixed(0)})`,
  );
}

/** OCR one manga page: detect text blocks, then read each (recognizeDets). */
export async function ocrPage(
  models: OcrModels,
  bitmap: ImageBitmap,
  pageIndex?: number,
): Promise<MokuroBlock[]> {
  const tDetect = performance.now();
  const dets = await detectOrdered(models, bitmap);
  const detectMs = performance.now() - tDetect;
  const timing: OcrTiming = { crop: 0, enc: 0, dec: 0 };
  const tBlocks = performance.now();
  const blocks = await recognizeDets(models, bitmap, dets, timing);
  if (debugTiming) {
    logPageTiming(
      pageIndex,
      performance.now() - tDetect,
      detectMs,
      dets.length,
      performance.now() - tBlocks,
      timing,
    );
  }
  return blocks;
}

/** Recognize a page from a stored detect skeleton: the exact float detector
    rects (`crops`) go straight through recognizeDets — no second detector
    pass, blocks identical to a full run. Debug reports detect 0. */
export async function ocrPageFromSkeleton(
  models: OcrModels,
  bitmap: ImageBitmap,
  crops: number[][],
  pageIndex?: number,
): Promise<MokuroBlock[]> {
  const timing: OcrTiming = { crop: 0, enc: 0, dec: 0 };
  const tBlocks = performance.now();
  const dets: Det[] = crops.map((c) => ({
    x1: c[0]!,
    y1: c[1]!,
    x2: c[2]!,
    y2: c[3]!,
    cls: 1,
    conf: 1,
  }));
  const blocks = await recognizeDets(models, bitmap, dets, timing);
  if (debugTiming) {
    const totalMs = performance.now() - tBlocks;
    logPageTiming(pageIndex, totalMs, 0, dets.length, totalMs, timing);
  }
  return blocks;
}
