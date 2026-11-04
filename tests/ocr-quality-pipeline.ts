// Node twin of the shipped OCR pipeline (src/core/ocr/detect.ts,
// pipeline.ts, decode.ts) for the quality harness: same constants, same
// detector post-processing, same lockstep batched greedy decode. Pixels
// come from a PixelSource (real Chrome canvas by default), and line
// splitting is the production module itself (src/core/ocr/lines.ts).
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { cropRect } from "../src/core/ocr/detect.ts";
import { grayFromRgba, splitLines } from "../src/core/ocr/lines.ts";
import { chwFromRgba, type PixelSource, type Rect } from "./ocr-quality-canvas.ts";
import { beamDecodeBatch, greedyDecodeBatch, greedyDecodeFullPrefix } from "./ocr-quality-decode.ts";
import { readBaberu, readPpocr, type Baberu, type Ppocr } from "./ocr-quality-alt.ts";

// ---------- pipeline constants (MUST match src/core/ocr/) ----------
const DETECT_SIZE = 640;
const CROP_SIZE = 224;
const CONF = 0.35;
const NMS_IOU = 0.5;
// Blocks per encode+decode round (1:1 with pipeline.ts BLOCK_BATCH).
const BLOCK_BATCH = 4;

export interface PipelineOptions {
  /** Fold crops to PIL "L" luma before the encoder (manga-ocr does). */
  gray: boolean;
  /** Read multi-line blocks line by line (src/core/ocr/lines.ts). */
  lines: boolean;
  /** Beams per crop: 1 = the shipped greedy decode; >1 = HF generate()'s
      beam search with manga-ocr's config (no_repeat_ngram_size=3,
      length_penalty=2.0, early_stopping). */
  beams: number;
  /** Glyph size (px of the 224² block crop) under which a block is read
      line by line (A/B knob; production default otherwise). */
  splitBelowPx?: number;
  /** Recognizer: the shipped manga-ocr, or an A/B alternative. */
  rec: "mocr" | "baberu" | "ppocr";
  /** Detector confidence floor (A/B knob; production CONF otherwise). */
  conf?: number;
}

export type Box = { x1: number; y1: number; x2: number; y2: number };
export interface Det extends Box {
  cls: number;
  conf: number;
}
export interface OcrBlock extends Box {
  text: string;
  lines: string[];
  vertical: boolean;
  conf: number;
  /** The recognition crops this block was read from (page pixels). */
  crops: Rect[];
}

export interface Sessions {
  det: ort.InferenceSession;
  enc: ort.InferenceSession;
  dec: ort.InferenceSession;
  vocab: string[];
  baberu?: Baberu;
  ppocr?: Ppocr;
}

export interface PageTiming {
  detect: number;
  split: number;
  crop: number;
  enc: number;
  dec: number;
  crops: number;
}

export const iou = (a: Box, b: Box): number => {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
};

async function detect(s: Sessions, px: PixelSource, w: number, h: number, minConf: number): Promise<Det[]> {
  const [rgba] = await px.rgba([{ sx: 0, sy: 0, sw: w, sh: h }], DETECT_SIZE);
  const chw = chwFromRgba(rgba!, DETECT_SIZE, false);
  const feeds: Record<string, ort.Tensor> = {
    images: new ort.Tensor("float32", chw, [1, 3, DETECT_SIZE, DETECT_SIZE]),
  };
  if (s.det.inputNames.includes("orig_target_sizes")) {
    feeds.orig_target_sizes = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(w), BigInt(h)]),
      [1, 2],
    );
  }
  const out = await s.det.run(feeds);
  const scores = out.scores!.data as Float32Array;
  const labels = out.labels!.data as BigInt64Array | Int32Array;
  const boxes = out.boxes!.data as Float32Array;
  const dets: Det[] = [];
  for (let i = 0; i < scores.length; i++) {
    const conf = scores[i]!;
    if (conf < minConf) continue;
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

function dedupeText(dets: Det[]): Det[] {
  const text = dets.filter((d) => d.cls !== 0).sort((a, b) => b.conf - a.conf);
  const kept: Det[] = [];
  for (const det of text) {
    if (kept.some((other) => iou(det, other) > NMS_IOU)) continue;
    kept.push(det);
  }
  return kept;
}

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

/** Native-resolution luma of a block's own box (no padding), for the line
    splitter. Native pixels need no resampling, so sharp and Chrome agree. */
async function blockGray(page: sharp.Sharp, d: Det, w: number, h: number) {
  const left = Math.max(0, Math.floor(d.x1));
  const top = Math.max(0, Math.floor(d.y1));
  const width = Math.min(w, Math.ceil(d.x2)) - left;
  const height = Math.min(h, Math.ceil(d.y2)) - top;
  if (width < 8 || height < 8) return null;
  const { data } = await page
    .clone()
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { gray: grayFromRgba(new Uint8Array(data), width, height), left, top };
}

/** One recognition crop: which block, which line, which chunk. */
interface CropJob {
  block: number;
  line: number;
  rect: Rect;
}

export async function ocrPage(
  s: Sessions,
  px: PixelSource,
  buf: Buffer,
  w: number,
  h: number,
  opts: PipelineOptions,
  timing: PageTiming,
): Promise<OcrBlock[]> {
  let t = performance.now();
  const dets = readingOrder(dedupeText(await detect(s, px, w, h, opts.conf ?? CONF)), w, h);
  timing.detect += performance.now() - t;

  // Every block becomes one or more crops (1:1 with pipeline.ts
  // recognizeDets): its padded whole-block rect, or its line chunks.
  t = performance.now();
  const page = opts.lines ? sharp(buf) : null;
  const jobs: CropJob[] = [];
  const vertical: boolean[] = [];
  const lineCount: number[] = [];
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i]!;
    const bw = d.x2 - d.x1, bh = d.y2 - d.y1;
    vertical[i] = bh > bw * 1.2;
    lineCount[i] = 1;
    const region = page ? await blockGray(page, d, w, h) : null;
    const split = region
      ? splitLines(region.gray, vertical[i]!, {
          ruby: opts.rec === "ppocr" ? "drop" : "fold",
          // The line recognizer reads every multi-line block line by line.
          splitBelowPx: opts.rec === "ppocr" ? Infinity : opts.splitBelowPx,
        })
      : null;
    if (split && region) {
      vertical[i] = split.vertical;
      lineCount[i] = split.lines.length;
      split.lines.forEach((chunks, li) => {
        for (const c of chunks) {
          const sx = Math.max(0, Math.round(region.left + c.x1));
          const sy = Math.max(0, Math.round(region.top + c.y1));
          const sw = Math.min(w, Math.round(region.left + c.x2)) - sx;
          const sh = Math.min(h, Math.round(region.top + c.y2)) - sy;
          if (sw >= 4 && sh >= 4) jobs.push({ block: i, line: li, rect: { sx, sy, sw, sh } });
        }
      });
      continue;
    }
    const rect = cropRect(d, w, h);
    if (rect) jobs.push({ block: i, line: 0, rect });
  }
  timing.split += performance.now() - t;

  timing.crops += jobs.length;
  const texts: string[] = [];
  if (opts.rec !== "mocr") {
    // A/B recognizers read crop by crop (their graphs are batch 1).
    t = performance.now();
    if (opts.rec === "baberu") {
      const rgba = await px.rgba(jobs.map((j) => j.rect), CROP_SIZE);
      for (const data of rgba) texts.push(await readBaberu(s.baberu!, data));
    } else {
      // A taller-than-wide line is vertical (Kellenok's own rule).
      for (const job of jobs) texts.push(await readPpocr(s.ppocr!, px, job.rect, job.rect.sh > job.rect.sw));
    }
    timing.enc += performance.now() - t;
    return assemble(dets, jobs, texts, lineCount, vertical);
  }
  t = performance.now();
  const rgba = await px.rgba(jobs.map((j) => j.rect), CROP_SIZE);
  const pxs = rgba.map((data) => chwFromRgba(data, CROP_SIZE, true, opts.gray));
  timing.crop += performance.now() - t;

  const toText = (ids: number[]) =>
    ids
      .slice(1)
      .map((id) => s.vocab[id] ?? "")
      .filter((token) => !/^(\[|<unused)/.test(token))
      .join("")
      .replace(/##/g, "")
      .trim();
  // Non-merged A/B decoders decode full-prefix, one crop at a time.
  const batchSize = s.dec.inputNames.includes("use_cache_branch") ? BLOCK_BATCH : 1;
  for (let start = 0; start < pxs.length; start += batchSize) {
    const batch = pxs.slice(start, start + batchSize);
    const plane = 3 * CROP_SIZE * CROP_SIZE;
    const data = new Float32Array(batch.length * plane);
    for (let j = 0; j < batch.length; j++) data.set(batch[j]!, j * plane);
    t = performance.now();
    const encOut = await s.enc.run({
      pixel_values: new ort.Tensor("float32", data, [batch.length, 3, CROP_SIZE, CROP_SIZE]),
    });
    timing.enc += performance.now() - t;
    t = performance.now();
    const idsBatch = s.dec.inputNames.includes("use_cache_branch")
      ? opts.beams > 1
        ? await beamDecodeBatch(s.dec, encOut.last_hidden_state!, opts.beams)
        : await greedyDecodeBatch(s.dec, encOut.last_hidden_state!)
      : [await greedyDecodeFullPrefix(s.dec, encOut.last_hidden_state!)];
    timing.dec += performance.now() - t;
    for (const ids of idsBatch) texts.push(toText(ids));
  }
  return assemble(dets, jobs, texts, lineCount, vertical);
}

/** Crop texts → blocks: a line's chunks concatenate, empty lines drop, a
    block with no text drops. */
function assemble(
  dets: Det[],
  jobs: CropJob[],
  texts: string[],
  lineCount: number[],
  vertical: boolean[],
): OcrBlock[] {
  const blocks: OcrBlock[] = [];
  for (let i = 0; i < dets.length; i++) {
    const lines: string[] = Array.from({ length: lineCount[i]! }, () => "");
    jobs.forEach((job, j) => {
      if (job.block === i) lines[job.line] += texts[j] ?? "";
    });
    const kept = lines.filter(Boolean);
    const text = kept.join("");
    if (!text) continue;
    blocks.push({
      ...dets[i]!,
      text,
      lines: kept,
      vertical: vertical[i]!,
      crops: jobs.filter((job) => job.block === i).map((job) => job.rect),
    });
  }
  return blocks;
}

