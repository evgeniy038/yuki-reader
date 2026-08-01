import { ort, type Tensor } from "./ort-runtime";
import type { MokuroBlock } from "../mokuro";
import type { OcrModels } from "./models";
import { fontSizeFor } from "./font-size";

// The OCR pipeline proper: ogkalu comic-text-and-bubble-detector at 640²
// finds text blocks → each crop (padded, NOT rotated — manga-ocr reads
// vertical text natively) goes through the manga-ocr vision encoder at 224²
// and a greedy char-WordPiece decoder. The three proven traps stay fixed:
//   1. orig_target_sizes wants (W, H), not the HF-usual (H, W);
//   2. detections are counted by scores.length (the export has a batch dim);
//   3. the decoder logits stride is the tensor's own dims[2] (vocab.txt has
//      a trailing newline — never index it by vocab.length).

const DETECT_SIZE = 640;
const CROP_SIZE = 224;
const CONF = 0.4;
const PAD_RATIO = 0.08;
/** Two detections overlapping this much are the same block — keep the surer. */
const NMS_IOU = 0.5;
const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_TOKENS = 300;
/** KV-cache decoder shape constants (merged model: 2 BERT layers, 12 heads). */
const KV_LAYERS = 2;
const KV_HEADS = 12;
const KV_DIM = 64;
// Runaway guard: on non-text texture (screentone, barcodes, book-spine
// patterns) the decoder loops — 300 dots, ははは…, 第条第条… A/B showed fp32
// weights loop on the same pages, so it is structural, not quantization.
// Stop the loop and trim the tail; real screams never reach these runs.
/** Same token this many times in a row = runaway (keep RUN_KEEP of them). */
const MAX_SAME_RUN = 15;
/** A 2..4-token cycle repeated to this total length = runaway. */
const MAX_CYCLE_RUN = 12;
const RUN_KEEP = 3;

/** If the generated tail of `ids` (after START) is a repeat run or a short
    cycle, return the length to truncate to; otherwise null. */
function runawayTruncateLen(ids: number[]): number | null {
  const n = ids.length;
  if (n < 2) return null;
  const last = ids[n - 1]!;
  let runStart = n - 1;
  while (runStart > 1 && ids[runStart - 1] === last) runStart--;
  if (n - runStart >= MAX_SAME_RUN) return runStart + RUN_KEEP;
  for (let k = 2; k <= 4; k++) {
    if (n - 1 < MAX_CYCLE_RUN) break;
    const tail = ids.slice(n - k).join();
    let reps = 1;
    while (
      n - (reps + 1) * k >= 1 &&
      ids.slice(n - (reps + 1) * k, n - reps * k).join() === tail
    ) {
      reps++;
    }
    if (reps * k >= MAX_CYCLE_RUN) return n - reps * k + k;
  }
  return null;
}

interface Det {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cls: number;
  conf: number;
}

function iou(a: Det, b: Det): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union =
    (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/** Canvas pixels → CHW float32, rescaled to 0..1 (the detector takes no
    mean/std normalization). */
const scratchCanvases = new Map<
  number,
  { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
>();
function scratchCtx(
  size: number,
): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  // One scratch canvas per target size (detect 640, crop 224): allocating an
  // OffscreenCanvas for every block showed up in the crop profile.
  let entry = scratchCanvases.get(size);
  if (!entry) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    entry = { canvas, ctx };
    scratchCanvases.set(size, entry);
  }
  return entry;
}

function chwPixels(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  size: number,
  normalize: boolean,
): Float32Array {
  const { ctx } = scratchCtx(size);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  // Single pass over pixels, three plane writes. normalize: (v/255-0.5)/0.5
  // is algebraically v*(2/255)-1 — one multiply, one subtract per channel.
  const k = normalize ? 2 / 255 : 1 / 255;
  const bias = normalize ? -1 : 0;
  for (let p = 0; p < plane; p++) {
    out[p] = data[p * 4]! * k + bias;
    out[plane + p] = data[p * 4 + 1]! * k + bias;
    out[2 * plane + p] = data[p * 4 + 2]! * k + bias;
  }
  return out;
}

async function detect(models: OcrModels, bitmap: ImageBitmap): Promise<Det[]> {
  const w = bitmap.width;
  const h = bitmap.height;
  const chw = chwPixels(bitmap, 0, 0, w, h, DETECT_SIZE, false);
  const feeds: Record<string, Tensor> = {
    images: new ort.Tensor("float32", chw, [1, 3, DETECT_SIZE, DETECT_SIZE]),
  };
  // Trap 1: this export scales x by sizes[0] and y by sizes[1].
  if (models.detector.inputNames.includes("orig_target_sizes")) {
    feeds.orig_target_sizes = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(w), BigInt(h)]),
      [1, 2],
    );
  }
  const out = await models.detector.run(feeds);
  // Post-processed export: scores [N], labels [N], boxes [N,4] absolute xyxy.
  const scores = out.scores!.data as Float32Array;
  const labels = out.labels!.data as BigInt64Array | Int32Array;
  const boxes = out.boxes!.data as Float32Array;
  const dets: Det[] = [];
  // Trap 2: iterate the flat scores, not dims[0].
  for (let i = 0; i < scores.length; i++) {
    const conf = scores[i]!;
    if (conf < CONF) continue;
    const x1 = boxes[i * 4]!;
    const y1 = boxes[i * 4 + 1]!;
    const x2 = boxes[i * 4 + 2]!;
    const y2 = boxes[i * 4 + 3]!;
    if (x2 - x1 < 8 || y2 - y1 < 8) continue;
    dets.push({
      x1: Math.max(0, x1),
      y1: Math.max(0, y1),
      x2: Math.min(w, x2),
      y2: Math.min(h, y2),
      cls: Number(labels[i]),
      conf,
    });
  }
  return dets;
}

/** Greedy NMS over the text classes: bubble (0) boxes only mark containers,
    and the detector fires near-duplicate text boxes over the same lines. */
function dedupeText(dets: Det[]): Det[] {
  const text = dets
    .filter((det) => det.cls !== 0)
    .sort((a, b) => b.conf - a.conf);
  const kept: Det[] = [];
  for (const det of text) {
    if (kept.some((other) => iou(det, other) > NMS_IOU)) continue;
    kept.push(det);
  }
  return kept;
}

/** Reading order: narrow vertical columns right→left, top→bottom inside. */
function readingOrder(dets: Det[], pageW: number, pageH: number): Det[] {
  const rowTol = Math.max(20, pageH * 0.02);
  return [...dets].sort((a, b) => {
    if (
      Math.abs(a.y1 - b.y1) > rowTol &&
      a.x2 - a.x1 < pageW * 0.3 &&
      b.x2 - b.x1 < pageW * 0.3
    ) {
      return b.x1 - a.x1;
    }
    return a.y1 - b.y1;
  });
}

// Optional per-stage timing (dev probes): when enabled, ocrPage logs how the
// page's time split between detection, canvas crops, the encoder and the
// decoder loop — the data pool-size and backend decisions are made from.
interface OcrTiming {
  crop: number;
  enc: number;
  dec: number;
}
let debugTiming = false;
export function setOcrDebugTiming(on: boolean): void {
  debugTiming = on;
}

/** Crop rect with padding, clamped to the page — null when the box is too
    small to read (mirrors the old "sw < 4 || sh < 4 → empty" skip). */
function cropRect(
  det: Det,
  pageW: number,
  pageH: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const pad = Math.max(
    4,
    Math.round(Math.min(det.x2 - det.x1, det.y2 - det.y1) * PAD_RATIO),
  );
  const sx = Math.max(0, Math.round(det.x1 - pad));
  const sy = Math.max(0, Math.round(det.y1 - pad));
  const sw = Math.min(pageW - sx, Math.round(det.x2 - det.x1 + 2 * pad));
  const sh = Math.min(pageH - sy, Math.round(det.y2 - det.y1 + 2 * pad));
  return sw < 4 || sh < 4 ? null : { sx, sy, sw, sh };
}

/** Greedy KV-cache decode of a WHOLE batch of blocks in lockstep: one
    decoder run per step advances every row at once (the shipped merged
    decoder has a dynamic batch dim). Every row starts at START together, so
    the batch is always rectangular — input_ids [B,1] each step, mask [B,
    step+1]; a row that hits EOS or the runaway guard is then fed EOS and
    ignored. The encoder output is always [B,197,768], so cross-attention
    needs no mask. Exported and validated in-house: batched output is
    token-exact vs solo decode (/tmp/mocr-validate-batch.py).
    Returns the cleaned text per row — "" when the crop reads as empty. */
async function decodeBlocks(
  models: OcrModels,
  hidden: Tensor,
  timing?: OcrTiming,
): Promise<string[]> {
  const t0 = performance.now();
  const batch = hidden.dims[0]!;
  const ids: number[][] = Array.from({ length: batch }, () => [START_TOKEN]);
  const done = new Array<boolean>(batch).fill(false);
  let remaining = batch;
  let past: Record<string, Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32",
          new Float32Array(0),
          [batch, KV_HEADS, 0, KV_DIM],
        );
  let useBranch = false;
  for (let step = 0; step < MAX_TOKENS && remaining > 0; step++) {
    const tokens = new BigInt64Array(batch);
    for (let j = 0; j < batch; j++) {
      const row = ids[j]!;
      tokens[j] = BigInt(
        !useBranch ? START_TOKEN : done[j] ? EOS_TOKEN : row[row.length - 1]!,
      );
    }
    const feeds: Record<string, Tensor> = {
      input_ids: new ort.Tensor("int64", tokens, [batch, 1]),
      encoder_hidden_states: hidden,
      attention_mask: new ort.Tensor(
        "int64",
        new BigInt64Array(batch * (step + 1)).fill(1n),
        [batch, step + 1],
      ),
      use_cache_branch: new ort.Tensor(
        "bool",
        new Uint8Array([useBranch ? 1 : 0]),
        [1],
      ),
    };
    Object.assign(feeds, past);
    const decOut = await models.decoder.run(feeds);
    for (const name of models.decoder.outputNames)
      if (name.startsWith("present."))
        past[name.replace("present", "past_key_values")] = decOut[name]!;
    const logits = decOut.logits!;
    // Trap 3: the vocab stride comes from the tensor, not vocab.txt. Logits
    // are [B, 1, vocab] — row j is one flat slice.
    const stride = logits.dims[2]!;
    const ldata = logits.data as Float32Array;
    for (let j = 0; j < batch; j++) {
      if (done[j]) continue;
      const row = ldata.subarray(j * stride, (j + 1) * stride);
      let best = 0;
      for (let i = 1; i < row.length; i++) if (row[i]! > row[best]!) best = i;
      if (best === EOS_TOKEN) {
        done[j] = true;
        remaining--;
        continue;
      }
      const rowIds = ids[j]!;
      rowIds.push(best);
      const cut = runawayTruncateLen(rowIds);
      if (cut !== null) {
        rowIds.length = cut;
        done[j] = true;
        remaining--;
      }
    }
    useBranch = true;
  }
  if (timing) timing.dec += performance.now() - t0;
  return ids.map((rowIds) =>
    rowIds
      .slice(1)
      .map((id) => models.vocab[id] ?? "")
      .filter((token) => !/^(\[|<unused)/.test(token))
      .join("")
      .replace(/##/g, "")
      .trim(),
  );
}

/** The final overlay block for a detection + its recognized text. */
function textBlock(det: Det, text: string): MokuroBlock {
  const width = det.x2 - det.x1;
  const height = det.y2 - det.y1;
  const vertical = height > width * 1.2;
  return {
    box: [
      Math.round(det.x1),
      Math.round(det.y1),
      Math.round(det.x2),
      Math.round(det.y2),
    ],
    vertical,
    font_size: fontSizeFor(width, height, text.length),
    lines: [text],
  };
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

/** Lazy-OCR skeleton: the box/vertical/font_size from the detector, no text
    yet — recognition fills `lines` on hover, in the reading window, or by
    the background catch-up pass. */
function skeletonBlock(det: Det): MokuroBlock {
  const width = det.x2 - det.x1;
  const height = det.y2 - det.y1;
  const vertical = height > width * 1.2;
  return {
    box: [
      Math.round(det.x1),
      Math.round(det.y1),
      Math.round(det.x2),
      Math.round(det.y2),
    ],
    vertical,
    font_size: fontSizeFor(width, height, 0),
    lines: [],
  };
}

/** Detect-only pass (lazy OCR): skeleton blocks with final boxes but empty
    lines — roughly 10x cheaper per page than full OCR. */
export async function detectPage(
  models: OcrModels,
  bitmap: ImageBitmap,
): Promise<MokuroBlock[]> {
  return readingOrder(
    dedupeText(await detect(models, bitmap)),
    bitmap.width,
    bitmap.height,
  ).map(skeletonBlock);
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

/** OCR one manga page: detect text blocks, read each, return overlay-ready
    blocks in reading order. Blocks go through the encoder AND the decoder in
    batches of BLOCK_BATCH — the batched decode is the point (the decoder
    dominates page time and its cost is per-run overhead), batching only the
    encoder with a per-block decode was measured a net loss (the GPU sync
    wait just moved into the dec phase). Everything stays strictly
    SEQUENTIAL: onnxruntime-web crashes when two sessions run concurrently in
    one runtime instance (OrtRun "__next_prime overflow"; the renderer never
    recovers). */
export async function ocrPage(
  models: OcrModels,
  bitmap: ImageBitmap,
  pageIndex?: number,
): Promise<MokuroBlock[]> {
  const tDetect = performance.now();
  const dets = readingOrder(
    dedupeText(await detect(models, bitmap)),
    bitmap.width,
    bitmap.height,
  );
  const detectMs = performance.now() - tDetect;
  const timing: OcrTiming = { crop: 0, enc: 0, dec: 0 };
  const tBlocks = performance.now();
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
      if (text) blocks.push(textBlock(batch[j]!.det, text));
    }
  }
  if (debugTiming) {
    const totalMs = performance.now() - tDetect;
    const blocksMs = performance.now() - tBlocks;
    console.debug(
      `[ocr-page] #${pageIndex ?? "?"} total ${totalMs.toFixed(0)}ms | ` +
        `detect ${detectMs.toFixed(0)} | blocks ${dets.length} in ${blocksMs.toFixed(0)} ` +
        `(crop ${timing.crop.toFixed(0)}, enc ${timing.enc.toFixed(0)}, dec ${timing.dec.toFixed(0)})`,
    );
  }
  return blocks;
}
