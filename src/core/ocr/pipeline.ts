import { ort, type Tensor } from "./ort-runtime";
import type { MokuroBlock } from "../mokuro";
import type { OcrModels } from "./models";
import { fontSizeFor } from "./font-size";
import { decodeBlocks, type OcrTiming } from "./decode";
import {
  chwPixels,
  cropRect,
  detBlock,
  detectOrdered,
  type Det,
} from "./detect";

// The OCR pipeline proper: ogkalu comic-text-and-bubble-detector at 640²
// finds text blocks (detect.ts) → each crop (padded, NOT rotated — manga-ocr
// reads vertical text natively) goes through the manga-ocr vision encoder at
// 224² and a greedy char-WordPiece decoder (decode.ts). This file keeps the
// recognize march — crops, batched encode/decode, the page entry points —
// and re-exports the detect pass, so consumers keep importing ./pipeline.

export { detectPage } from "./detect";

const CROP_SIZE = 224;

let debugTiming = false;
export function setOcrDebugTiming(on: boolean): void {
  debugTiming = on;
}

async function ocrCrop(
  models: OcrModels,
  bitmap: ImageBitmap,
  det: Det,
  timing?: OcrTiming,
): Promise<string> {
  const rect = cropRect(det, bitmap.width, bitmap.height);
  if (!rect) return "";
  const t0 = performance.now();
  const px = chwPixels(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, CROP_SIZE, true);
  const t1 = performance.now();
  const input = new ort.Tensor("float32", px, [1, 3, CROP_SIZE, CROP_SIZE]);
  const encOut = await models.encoder.run({ pixel_values: input });
  input.dispose();
  const hidden = encOut.last_hidden_state!;
  const t2 = performance.now();
  const [text = ""] = await decodeBlocks(models, hidden, timing);
  hidden.dispose();
  if (timing) {
    timing.crop += t1 - t0;
    timing.enc += t2 - t1;
  }
  return text;
}

/** Recognize the text of one previously detected block (hover-triggered
    lazy OCR). Returns null when the crop reads as empty. */
export async function recognizeBlock(
  models: OcrModels,
  bitmap: ImageBitmap,
  block: MokuroBlock,
): Promise<MokuroBlock | null> {
  const [x1, y1, x2, y2] = block.box;
  const det: Det = { x1, y1, x2, y2, cls: 1, conf: 1 };
  const text = await ocrCrop(models, bitmap, det);
  if (!text) return null;
  const width = x2 - x1;
  const height = y2 - y1;
  const vertical = height > width * 1.2;
  return {
    ...block,
    vertical,
    font_size: fontSizeFor(width, height, text.length),
    lines: [text],
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

/** Read a list of detections: crop each (padded), encode AND decode in
    batches of BLOCK_BATCH, return overlay-ready blocks in input order
    (empty reads dropped). The batched decode is the point — batching only
    the encoder with a per-block decode measured a net loss (the GPU sync
    wait just moved into the dec phase). Shared by ocrPage and
    ocrPageFromSkeleton so identical rects give identical blocks. Strictly
    SEQUENTIAL: onnxruntime-web crashes when two sessions run concurrently
    in one runtime instance (OrtRun "__next_prime overflow"). */
async function recognizeDets(
  models: OcrModels,
  bitmap: ImageBitmap,
  dets: Det[],
  timing: OcrTiming,
): Promise<MokuroBlock[]> {
  const valid: { det: Det; px: Float32Array }[] = [];
  for (const det of dets) {
    const rect = cropRect(det, bitmap.width, bitmap.height);
    if (!rect) continue;
    const t0 = performance.now();
    valid.push({
      det,
      px: chwPixels(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, CROP_SIZE, true),
    });
    timing.crop += performance.now() - t0;
  }
  const blocks: MokuroBlock[] = [];
  for (let start = 0; start < valid.length; start += BLOCK_BATCH) {
    const batch = valid.slice(start, start + BLOCK_BATCH);
    const hidden = await encodeBatch(
      models,
      batch.map(({ px }) => px),
      timing,
    );
    const texts = await decodeBlocks(models, hidden, timing);
    hidden.dispose();
    for (let j = 0; j < batch.length; j++) {
      const text = texts[j]!;
      if (text) blocks.push(detBlock(batch[j]!.det, text));
    }
  }
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
