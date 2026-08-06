import { ort, type Tensor } from "./ort-runtime";
import type { MokuroBlock } from "../mokuro";
import type { OcrModels } from "./models";
import { fontSizeFor } from "./font-size";

// The detection half of the OCR pipeline: ogkalu comic-text-and-bubble-
// detector at 640² finds text blocks (each crop is then read by the
// recognize march in pipeline.ts). Two proven traps stay fixed:
//   1. orig_target_sizes wants (W, H), not the HF-usual (H, W);
//   2. detections are counted by scores.length (the export has a batch dim).

const DETECT_SIZE = 640;
const CONF = 0.4;
const PAD_RATIO = 0.08;
/** Two detections overlapping this much are the same block — keep the surer. */
const NMS_IOU = 0.5;

export interface Det {
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

export function chwPixels(
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

/** Text blocks of a page, deduped and sorted in reading order. */
export async function detectOrdered(
  models: OcrModels,
  bitmap: ImageBitmap,
): Promise<Det[]> {
  return readingOrder(
    dedupeText(await detect(models, bitmap)),
    bitmap.width,
    bitmap.height,
  );
}

/** Crop rect with padding, clamped to the page — null when the box is too
    small to read (mirrors the old "sw < 4 || sh < 4 → empty" skip). */
export function cropRect(
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

/** The final overlay block for a detection: box/vertical/font_size are final
    from the detector alone; `text` (when read already) fills `lines` — a
    lazy-OCR skeleton is the same block with empty lines. */
export function detBlock(det: Det, text = ""): MokuroBlock {
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
    lines: text ? [text] : [],
  };
}

/** Skeleton blocks (final boxes, empty lines) plus the exact float detector
    rects aligned with them, so recognition reuses the detector's crops. */
interface DetectResult {
  blocks: MokuroBlock[];
  crops: number[][];
}

/** Detect-only pass (lazy OCR): skeletons — ~10x cheaper than full OCR. */
export async function detectPage(
  models: OcrModels,
  bitmap: ImageBitmap,
): Promise<DetectResult> {
  const dets = await detectOrdered(models, bitmap);
  return {
    blocks: dets.map((det) => detBlock(det)),
    crops: dets.map((det) => [det.x1, det.y1, det.x2, det.y2]),
  };
}
