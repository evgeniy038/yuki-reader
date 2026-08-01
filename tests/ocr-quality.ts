// OCR quality harness: runs the SHIPPED browser pipeline (src/core/ocr/
// pipeline.ts — same params, sharp in place of canvas) in Node over whole
// volumes, then scores it against a .mokuro sidecar and/or a vision-verified
// golden file. This is the quality gate: perf numbers live in ocr-smoke,
// accuracy lives here.
//
//   pnpm tsx tests/ocr-quality.ts --vol kaguya [--pages 6,7|all] \
//     [--models q8|merged|q4f16|fp32|l0] [--det s|full|fp16] [--dump] [--iou 0.2] \
//     [--gate [--gate-recall 0.85] [--gate-cer 0.10] [--gate-runaway 0]]
//
// --dump writes mismatch crops + full pages to /tmp/ocr-quality/<tag>/ for
// vision review. Reports land in /tmp/ocr-quality/report-<tag>.json.
// --gate scores the run against tests/golden/<vol>.json (box match when the
// golden block has one, page-level text match when it doesn't) and exits 1
// when recall / mean-CER / runaway-count breach their thresholds.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { unzipSync } from "fflate";
import * as ort from "onnxruntime-node";
import sharp from "sharp";

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : dflt;
};
const VOL = opt("vol", "kaguya");
const PAGES_OPT = opt("pages", "all");
const MODELS = opt("models", "q8");
const DET = opt("det", "s");
const DUMP = args.includes("--dump");
const GATE = args.includes("--gate");
const GATE_RECALL = Number(opt("gate-recall", "0.85"));
const GATE_CER = Number(opt("gate-cer", "0.10"));
const GATE_RUNAWAY = Number(opt("gate-runaway", "0"));
const MATCH_IOU = Number(opt("iou", "0.2"));

// ---------- volumes ----------
const MANGA_DIR =
  process.env.YUKI_TEST_MANGA_DIR ??
  "/Users/evegnius/Desktop/work_hobbies/言語学習者/manga";
const KAGUYA = join(MANGA_DIR, "kaguya");
const VOLS: Record<
  string,
  { images: () => { name: string; buf: Buffer }[]; mokuro?: string; golden?: string }
> = {
  kaguya: {
    images: () =>
      fromArchive(
        join(KAGUYA, "Kaguya-sama (Upscaled) - [赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 01.cbz"),
      ),
    mokuro: join(KAGUYA, "[赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 01.mokuro"),
    golden: "tests/golden/kaguya-01.json",
  },
  "kaguya-zip": {
    images: () =>
      fromArchive(join(KAGUYA, "[赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 第01巻.zip")),
  },
  oshinoko: {
    images: () => fromDir(join(MANGA_DIR, "Oshinoko_1")),
    mokuro: join(MANGA_DIR, "Oshinoko_1.mokuro"),
    golden: "tests/golden/oshinoko-01.json",
  },
  steinsgate: {
    images: () => fromDir(join(MANGA_DIR, "steinsgate", "vol1")),
    golden: "tests/golden/steinsgate-01.json",
  },
};

function fromArchive(path: string): { name: string; buf: Buffer }[] {
  const entries = unzipSync(readFileSync(path));
  return Object.keys(entries)
    .filter((k) => /\.(jpe?g|png|webp)$/i.test(k) && !k.includes("__MACOSX"))
    .sort()
    .map((k) => ({ name: basename(k), buf: Buffer.from(entries[k]!) }));
}
function fromDir(dir: string): { name: string; buf: Buffer }[] {
  return readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .map((f) => ({ name: f, buf: readFileSync(join(dir, f)) }));
}

// ---------- models ----------
const MODEL_DIR = "/tmp/yuki-ocr-models";
const MODEL_SETS: Record<string, { enc: string; dec: string; vocab: string }> = {
  q8: { enc: "encoder_q8.onnx", dec: "decoder_q8.onnx", vocab: "vocab.txt" },
  merged: { enc: "encoder_q8.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  q4f16: { enc: "encoder_model_q4f16.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  fp32: { enc: "encoder_fp32.onnx", dec: "decoder_fp32.onnx", vocab: "vocab.txt" },
  l0: { enc: "l0_encoder.onnx", dec: "l0_decoder.onnx", vocab: "vocab.txt" },
};
const DETECTORS: Record<string, string> = {
  s: "detector-v4-s_int8.onnx",
  full: "detector_int8.onnx",
  // The shipped WebGPU build: fp16 conversion of the fp32 export. On CPU
  // (this harness runs onnxruntime-node) it is slower than int8 but the
  // boxes are what the browser's GPU actually produces.
  fp16: "detector_fp16.onnx",
};

// ---------- pipeline constants (MUST match src/core/ocr/pipeline.ts) ----------
const DETECT_SIZE = 640;
const CROP_SIZE = 224;
const CONF = 0.4;
const PAD_RATIO = 0.08;
const NMS_IOU = 0.5;
const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_TOKENS = 300;
// Blocks per encode+decode round (1:1 with pipeline.ts BLOCK_BATCH).
const BLOCK_BATCH = 4;
// Runaway guard (1:1 with pipeline.ts): decoder repeat/cycle loops on
// non-text texture; fp32 does not fix it. Stop + trim the tail.
const MAX_SAME_RUN = 15;
const MAX_CYCLE_RUN = 12;
const RUN_KEEP = 3;

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

type Box = { x1: number; y1: number; x2: number; y2: number };
interface Det extends Box {
  cls: number;
  conf: number;
}

const iou = (a: Box, b: Box): number => {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
};

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n]!;
}

const norm = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[、。．.！？!?・…ー〜~「」『』（）()【】〈〉《》◆★☆：:]/g, "");
const cer = (a: string, b: string): number =>
  levenshtein(norm(a), norm(b)) / Math.max(1, norm(b).length);

// decoder runaway: same glyph repeated 20+ times, or absurd length — the model
// looping on texture, not real text (real sfx runs are <20 chars).
const isRunaway = (t: string): boolean => t.length > 150 || /(.)\1{19,}/u.test(t);

// ---------- pipeline (Node twin of src/core/ocr/pipeline.ts) ----------
async function chwFromSharp(
  img: sharp.Sharp,
  size: number,
  normalize: boolean,
): Promise<Float32Array> {
  const { data } = await img
    .clone()
    .resize(size, size, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(3 * size * size);
  for (let c = 0; c < 3; c++)
    for (let p = 0; p < size * size; p++) {
      const v = data[p * 3 + c]! / 255;
      out[c * size * size + p] = normalize ? (v - 0.5) / 0.5 : v;
    }
  return out;
}

async function detect(
  session: ort.InferenceSession,
  buf: Buffer,
  w: number,
  h: number,
): Promise<Det[]> {
  const chw = await chwFromSharp(sharp(buf), DETECT_SIZE, false);
  const feeds: Record<string, ort.Tensor> = {
    images: new ort.Tensor("float32", chw, [1, 3, DETECT_SIZE, DETECT_SIZE]),
  };
  if (session.inputNames.includes("orig_target_sizes")) {
    feeds.orig_target_sizes = new ort.Tensor(
      "int64",
      BigInt64Array.from([BigInt(w), BigInt(h)]),
      [1, 2],
    );
  }
  const out = await session.run(feeds);
  const scores = out.scores!.data as Float32Array;
  const labels = out.labels!.data as BigInt64Array | Int32Array;
  const boxes = out.boxes!.data as Float32Array;
  const dets: Det[] = [];
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

interface OcrBlock extends Box {
  text: string;
  vertical: boolean;
  conf: number;
}

async function ocrPage(
  det: ort.InferenceSession,
  enc: ort.InferenceSession,
  dec: ort.InferenceSession,
  vocab: string[],
  buf: Buffer,
  pageBuf: sharp.Sharp,
  w: number,
  h: number,
  pageIdx: number,
  dumpDir: string | null,
): Promise<OcrBlock[]> {
  const dets = readingOrder(dedupeText(await detect(det, buf, w, h)), w, h);
  const blocks: OcrBlock[] = [];
  const toText = (ids: number[]) =>
    ids
      .slice(1)
      .map((id) => vocab[id] ?? "")
      .filter((token) => !/^(\[|<unused)/.test(token))
      .join("")
      .replace(/##/g, "")
      .trim();
  const pushBlock = (d: Det, text: string) => {
    if (!text) return;
    const bw = d.x2 - d.x1, bh = d.y2 - d.y1;
    blocks.push({ ...d, text, vertical: bh > bw * 1.2 });
  };

  // Crop every valid block first (1:1 with pipeline.ts ocrPage).
  const valid: { d: Det; px: Float32Array }[] = [];
  for (let i = 0; i < dets.length; i++) {
    const d = dets[i]!;
    const pad = Math.max(4, Math.round(Math.min(d.x2 - d.x1, d.y2 - d.y1) * PAD_RATIO));
    const sx = Math.max(0, Math.round(d.x1 - pad));
    const sy = Math.max(0, Math.round(d.y1 - pad));
    const sw = Math.min(w - sx, Math.round(d.x2 - d.x1 + 2 * pad));
    const sh = Math.min(h - sy, Math.round(d.y2 - d.y1 + 2 * pad));
    if (sw < 4 || sh < 4) continue;
    const cropBuf = await pageBuf
      .clone()
      .extract({ left: sx, top: sy, width: sw, height: sh })
      .png()
      .toBuffer();
    if (dumpDir) writeFileSync(join(dumpDir, `p${pageIdx}-b${i}.png`), cropBuf);
    valid.push({ d, px: await chwFromSharp(sharp(cropBuf), CROP_SIZE, true) });
  }

  if (!dec.inputNames.includes("use_cache_branch")) {
    // Fallback for non-merged A/B decoders: per-block full-prefix decode.
    for (const { d, px } of valid) {
      const encOut = await enc.run({
        pixel_values: new ort.Tensor("float32", px, [1, 3, CROP_SIZE, CROP_SIZE]),
      });
      pushBlock(d, toText(await greedyDecode(dec, encOut.last_hidden_state!)));
    }
    return blocks;
  }

  // Shipped path (1:1 with pipeline.ts): encode+decode in lockstep batches.
  for (let start = 0; start < valid.length; start += BLOCK_BATCH) {
    const batch = valid.slice(start, start + BLOCK_BATCH);
    const plane = 3 * CROP_SIZE * CROP_SIZE;
    const data = new Float32Array(batch.length * plane);
    for (let j = 0; j < batch.length; j++) data.set(batch[j]!.px, j * plane);
    const encOut = await enc.run({
      pixel_values: new ort.Tensor("float32", data, [batch.length, 3, CROP_SIZE, CROP_SIZE]),
    });
    const idsBatch = await greedyDecodeBatch(dec, encOut.last_hidden_state!);
    for (let j = 0; j < batch.length; j++) pushBlock(batch[j]!.d, toText(idsBatch[j]!));
  }
  return blocks;
}

// Greedy decode (1:1 with pipeline.ts). If the decoder session exposes a
// use_cache_branch input (merged KV-cache model), decode one token per step
// reusing past_key_values; otherwise fall back to full-prefix decoding.
const KV_LAYERS = 2;
const KV_HEADS = 12;
const KV_DIM = 64;
async function greedyDecode(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
): Promise<number[]> {
  const ids: number[] = [START_TOKEN];
  const useKv = dec.inputNames.includes("use_cache_branch");
  let past: Record<string, ort.Tensor> = {};
  if (useKv) {
    for (let l = 0; l < KV_LAYERS; l++)
      for (const kind of ["decoder", "encoder"])
        for (const kv of ["key", "value"])
          past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
            "float32", new Float32Array(0), [1, KV_HEADS, 0, KV_DIM]);
  }
  let useBranch = false;
  for (let step = 0; step < MAX_TOKENS; step++) {
    const stepIds = useBranch ? [ids[ids.length - 1]!] : ids;
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(stepIds.map(BigInt)), [1, stepIds.length]),
      encoder_hidden_states: hidden,
    };
    if (useKv) {
      feeds["attention_mask"] = new ort.Tensor(
        "int64", BigInt64Array.from({ length: ids.length }, () => 1n), [1, ids.length]);
      feeds["use_cache_branch"] = new ort.Tensor("bool", new Uint8Array([useBranch ? 1 : 0]), [1]);
      Object.assign(feeds, past);
    }
    const decOut = await dec.run(feeds);
    if (useKv) {
      for (const name of dec.outputNames)
        if (name.startsWith("present."))
          past[name.replace("present", "past_key_values")] = decOut[name]!;
    }
    const logits = decOut.logits!.data as Float32Array;
    const stride = decOut.logits!.dims[2]!;
    const row = logits.subarray((stepIds.length - 1) * stride, stepIds.length * stride);
    let best = 0;
    for (let t = 1; t < row.length; t++) if (row[t]! > row[best]!) best = t;
    if (best === EOS_TOKEN) break;
    ids.push(best);
    useBranch = true;
    const cut = runawayTruncateLen(ids);
    if (cut !== null) {
      ids.length = cut;
      break;
    }
  }
  return ids;
}

// Lockstep batched greedy decode (1:1 with pipeline.ts decodeBlocks): one
// run per step advances the whole batch; rows all start at START together,
// so every step is rectangular — input_ids [B,1], mask [B, step+1]. A row
// that hits EOS or the runaway guard is then fed EOS and ignored.
async function greedyDecodeBatch(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
): Promise<number[][]> {
  const batch = hidden.dims[0]!;
  const ids: number[][] = Array.from({ length: batch }, () => [START_TOKEN]);
  const done = new Array<boolean>(batch).fill(false);
  let remaining = batch;
  const past: Record<string, ort.Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32", new Float32Array(0), [batch, KV_HEADS, 0, KV_DIM]);
  let useBranch = false;
  for (let step = 0; step < MAX_TOKENS && remaining > 0; step++) {
    const tokens = new BigInt64Array(batch);
    for (let j = 0; j < batch; j++) {
      const row = ids[j]!;
      tokens[j] = BigInt(
        !useBranch ? START_TOKEN : done[j] ? EOS_TOKEN : row[row.length - 1]!,
      );
    }
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", tokens, [batch, 1]),
      encoder_hidden_states: hidden,
      attention_mask: new ort.Tensor(
        "int64", new BigInt64Array(batch * (step + 1)).fill(1n), [batch, step + 1]),
      use_cache_branch: new ort.Tensor("bool", new Uint8Array([useBranch ? 1 : 0]), [1]),
      ...past,
    };
    const decOut = await dec.run(feeds);
    for (const name of dec.outputNames)
      if (name.startsWith("present."))
        past[name.replace("present", "past_key_values")] = decOut[name]!;
    const logits = decOut.logits!.data as Float32Array;
    const stride = decOut.logits!.dims[2]!;
    for (let j = 0; j < batch; j++) {
      if (done[j]) continue;
      const row = logits.subarray(j * stride, (j + 1) * stride);
      let best = 0;
      for (let t = 1; t < row.length; t++) if (row[t]! > row[best]!) best = t;
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
  return ids;
}

// ---------- comparison ----------
// A ref block may have no box (text-only golden): then it matches any unused
// ours block on the same page with normalized CER <= TEXT_MATCH_CER.
const TEXT_MATCH_CER = 0.2;
interface RefBlock extends Partial<Box> {
  text: string;
}
interface PageReport {
  page: number;
  img: string;
  ours: number;
  ref: number;
  matched: number;
  missed: RefBlock[];
  extra: OcrBlock[];
  diffs: { ours: string; ref: string; cer: number; box: number[]; iou: number }[];
  meanCer: number;
  all: OcrBlock[];
}

function comparePage(
  page: number,
  img: string,
  ours: OcrBlock[],
  ref: RefBlock[],
): PageReport {
  const diffs: PageReport["diffs"] = [];
  const missed: RefBlock[] = [];
  const used = new Set<number>();
  let cerSum = 0;
  let matched = 0;
  for (const rb of ref) {
    const hasBox = rb.x1 !== undefined && rb.y1 !== undefined && rb.x2 !== undefined && rb.y2 !== undefined;
    let bestIou = 0, bestIdx = -1, bestCer = Infinity;
    for (let i = 0; i < ours.length; i++) {
      if (used.has(i)) continue;
      if (hasBox) {
        const v = iou(rb as Box, ours[i]!);
        if (v > bestIou) { bestIou = v; bestIdx = i; }
      } else {
        const c = cer(ours[i]!.text, rb.text);
        if (c < bestCer) { bestCer = c; bestIdx = i; }
      }
    }
    let ok = hasBox ? bestIou >= MATCH_IOU : bestCer <= TEXT_MATCH_CER;
    if (ok && bestIdx >= 0) {
      used.add(bestIdx);
      matched++;
      const c = cer(ours[bestIdx]!.text, rb.text);
      cerSum += c;
      if (c > 0.08) {
        diffs.push({
          ours: ours[bestIdx]!.text,
          ref: rb.text,
          cer: c,
          iou: hasBox ? bestIou : -1,
          box: hasBox
            ? [rb.x1!, rb.y1!, rb.x2!, rb.y2!].map(Math.round)
            : [ours[bestIdx]!.x1, ours[bestIdx]!.y1, ours[bestIdx]!.x2, ours[bestIdx]!.y2].map(Math.round),
        });
      }
      continue;
    }
    // Split recovery: a boxed ref we failed to match 1:1 may be the detector
    // splitting one bubble into several blocks (dense monologue columns). Try
    // unions of up to 3 consecutive unused ours blocks: if the union covers
    // the ref and the combined text reads right, it is a match, not a miss.
    if (hasBox) {
      let done = false;
      outer: for (let i = 0; i < ours.length && !done; i++) {
        if (used.has(i)) continue;
        const grp: number[] = [];
        let ux1 = Infinity, uy1 = Infinity, ux2 = -Infinity, uy2 = -Infinity;
        for (let j = i; j < Math.min(ours.length, i + 3); j++) {
          if (used.has(j)) continue outer;
          const o = ours[j]!;
          ux1 = Math.min(ux1, o.x1); uy1 = Math.min(uy1, o.y1);
          ux2 = Math.max(ux2, o.x2); uy2 = Math.max(uy2, o.y2);
          grp.push(j);
          const v = iou(rb as Box, { x1: ux1, y1: uy1, x2: ux2, y2: uy2 });
          if (v >= MATCH_IOU) {
            const text = grp.map((g) => ours[g]!.text).join("");
            const c = cer(text, rb.text);
            if (c <= TEXT_MATCH_CER) {
              for (const g of grp) used.add(g);
              matched++;
              cerSum += c;
              if (c > 0.08) {
                diffs.push({
                  ours: text, ref: rb.text, cer: c, iou: v,
                  box: [rb.x1!, rb.y1!, rb.x2!, rb.y2!].map(Math.round),
                });
              }
              done = true;
              break;
            }
          }
        }
      }
      if (done) continue;
    }
    missed.push(rb);
  }
  const extra = ours.filter((_, i) => !used.has(i));
  return {
    page, img,
    ours: ours.length, ref: ref.length, matched,
    missed, extra, diffs,
    meanCer: matched > 0 ? cerSum / matched : 0,
    all: ours,
  };
}

// ---------- main ----------
const vol = VOLS[VOL];
if (!vol) throw new Error(`unknown vol ${VOL} (have ${Object.keys(VOLS).join(", ")})`);
const tag = `${VOL}-${MODELS}-${DET}`;
const OUT = join("/tmp/ocr-quality", tag);
mkdirSync(OUT, { recursive: true });
if (DUMP) mkdirSync(join(OUT, "crops"), { recursive: true });

const pages = vol.images();
console.log(`volume ${VOL}: ${pages.length} pages`);
const pageIdxs =
  PAGES_OPT === "all"
    ? pages.map((_, i) => i)
    : PAGES_OPT.split(",").map(Number);

const refPages: { blocks: { box: number[]; lines: string[]; vertical?: boolean }[] }[] | null =
  vol.mokuro && existsSync(vol.mokuro)
    ? (JSON.parse(readFileSync(vol.mokuro, "utf8")) as { pages: never[] }).pages
    : null;
const golden: { pages: { page: number; blocks: { box: number[] | null; text: string; src?: string }[] }[] } | null =
  vol.golden && existsSync(vol.golden)
    ? JSON.parse(readFileSync(vol.golden, "utf8"))
    : null;
console.log(`reference: ${refPages ? "mokuro" : "none"}, golden: ${golden ? "yes" : "none"}`);

const set = MODEL_SETS[MODELS]!;
const [detSession, encSession, decSession] = await Promise.all([
  ort.InferenceSession.create(join(MODEL_DIR, DETECTORS[DET]!), { executionProviders: ["cpu"] }),
  ort.InferenceSession.create(join(MODEL_DIR, set.enc), { executionProviders: ["cpu"] }),
  ort.InferenceSession.create(join(MODEL_DIR, set.dec), { executionProviders: ["cpu"] }),
]);
const vocab = readFileSync(join(MODEL_DIR, set.vocab), "utf8").split("\n");
console.log(`sessions ready (det ${DET}, models ${MODELS})`);

const reports: PageReport[] = [];
for (const pi of pageIdxs) {
  const page = pages[pi];
  if (!page) continue;
  const meta = await sharp(page.buf).metadata();
  const w = meta.width!, h = meta.height!;
  const t0 = performance.now();
  const ours = await ocrPage(
    detSession, encSession, decSession, vocab,
    page.buf, sharp(page.buf), w, h, pi,
    DUMP ? join(OUT, "crops") : null,
  );
  if (DUMP) {
    writeFileSync(join(OUT, `page-${pi}.jpg`), await sharp(page.buf).jpeg({ quality: 80 }).toBuffer());
  }
  const ref: RefBlock[] = (refPages?.[pi]?.blocks ?? []).map((b) => ({
    x1: b.box[0]!, y1: b.box[1]!, x2: b.box[2]!, y2: b.box[3]!,
    text: b.lines.join(""),
  }));
  const goldPage = golden?.pages.find((g) => g.page === pi);
  const refFinal: RefBlock[] = goldPage
    ? goldPage.blocks.map((b) =>
        b.box
          ? { x1: b.box[0]!, y1: b.box[1]!, x2: b.box[2]!, y2: b.box[3]!, text: b.text }
          : { text: b.text },
      )
    : ref;
  const report = comparePage(pi, page.name, ours, refFinal);
  reports.push(report);
  const dt = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `p${pi} ${page.name}: ours ${report.ours} ref ${report.ref} matched ${report.matched} ` +
      `miss ${report.missed.length} extra ${report.extra.length} CER ${report.meanCer.toFixed(3)} (${dt}s)`,
  );
}

const totalMatched = reports.reduce((s, r) => s + r.matched, 0);
const totalRef = reports.reduce((s, r) => s + r.ref, 0);
const totalOurs = reports.reduce((s, r) => s + r.ours, 0);
const totalMiss = reports.reduce((s, r) => s + r.missed.length, 0);
const totalExtra = reports.reduce((s, r) => s + r.extra.length, 0);
const allDiffs = reports.flatMap((r) => r.diffs.map((d) => ({ ...d, page: r.page })));
const meanCer =
  reports.reduce((s, r) => s + r.meanCer * r.matched, 0) / Math.max(1, totalMatched);

console.log(`\n=== ${tag} over ${reports.length} pages ===`);
console.log(`blocks: ours ${totalOurs} | ref ${totalRef} | matched ${totalMatched} | missed ${totalMiss} | extra ${totalExtra}`);
console.log(`mean CER on matched: ${meanCer.toFixed(4)} | diffs >8%: ${allDiffs.length}`);
allDiffs
  .sort((a, b) => b.cer - a.cer)
  .slice(0, 30)
  .forEach((d) =>
    console.log(`  p${d.page} CER ${d.cer.toFixed(2)} IoU ${d.iou.toFixed(2)}\n    ours: ${d.ours}\n    ref:  ${d.ref}`),
  );
writeFileSync(
  join("/tmp/ocr-quality", `report-${tag}.json`),
  JSON.stringify({ tag, totalOurs, totalRef, totalMatched, totalMiss, totalExtra, meanCer, reports }, null, 2),
);
console.log(`report: /tmp/ocr-quality/report-${tag}.json`);

// ---------- quality gate (--gate): verdict against the golden file ----------
if (GATE) {
  if (!golden) {
    console.error("gate: no golden file for this volume");
    process.exitCode = 2;
  } else {
    const goldPageNums = new Set(golden.pages.map((g) => g.page));
    const goldReports = reports.filter((r) => goldPageNums.has(r.page));
    const gRef = goldReports.reduce((s, r) => s + r.ref, 0);
    const gMatched = goldReports.reduce((s, r) => s + r.matched, 0);
    const gCer =
      goldReports.reduce((s, r) => s + r.meanCer * r.matched, 0) / Math.max(1, gMatched);
    const runaways = goldReports.flatMap((r) =>
      r.extra.filter((b) => isRunaway(b.text)).map((b) => ({ page: r.page, text: b.text })),
    );
    const checks = [
      { name: `recall ${(gMatched / Math.max(1, gRef)).toFixed(3)} >= ${GATE_RECALL}`, ok: gMatched / Math.max(1, gRef) >= GATE_RECALL },
      { name: `meanCER ${gCer.toFixed(4)} <= ${GATE_CER}`, ok: gCer <= GATE_CER },
      { name: `runaways ${runaways.length} <= ${GATE_RUNAWAY}`, ok: runaways.length <= GATE_RUNAWAY },
    ];
    console.log(`\n=== GATE (${VOL}, ${goldReports.length} golden pages, ${gRef} blocks) ===`);
    for (const c of checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    for (const r of runaways.slice(0, 5))
      console.log(`  runaway p${r.page}: ${r.text.slice(0, 60)}…`);
    const failed = checks.filter((c) => !c.ok);
    console.log(failed.length ? `GATE: FAIL (${failed.length} criteria)` : "GATE: PASS");
    process.exitCode = failed.length ? 1 : 0;
  }
}
