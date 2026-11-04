// Alternative recognizers for the quality harness A/B (not shipped):
//   baberu — genshiai-daichi/baberu-ocr v1.2 (Apache-2.0): DINOv2 vision
//            graph + 6-layer decoder with KV cache, reads a whole block at
//            224² like manga-ocr. Decode as its onnx_infer.py: greedy,
//            repetition_penalty 1.2, run caps 12 (letters) / 16 (symbols).
//   ppocr  — Kellenok/PP-OCRv6_manga v0.2 rec (Apache-2.0): CTC line
//            recognizer, height 48, vertical lines rotated 90° CCW, BGR.
// Model files come from YUKI_OCR_ALT_DIR (baberu/onnx, baberu/tokenizer,
// ppocr/rec, ppocr/ppocrv6_dict.txt).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import type { PixelSource, Rect } from "./ocr-quality-canvas.ts";

export interface Baberu {
  vis: ort.InferenceSession;
  pre: ort.InferenceSession;
  stp: ort.InferenceSession;
  charset: string[];
  content: Set<number>;
}

export interface Ppocr {
  rec: ort.InferenceSession;
  vocab: string[];
}

export async function loadBaberu(dir: string, opts: ort.InferenceSession.SessionOptions): Promise<Baberu> {
  const charset = JSON.parse(readFileSync(join(dir, "tokenizer", "vocab.json"), "utf8")) as string[];
  const content = new Set<number>();
  charset.forEach((ch, i) => {
    if ([...ch].length === 1 && !"ーｰ〜~".includes(ch) && /^[\p{L}\p{N}]$/u.test(ch)) content.add(i + 4);
  });
  return {
    vis: await ort.InferenceSession.create(join(dir, "onnx", "vision_int4.onnx"), opts),
    pre: await ort.InferenceSession.create(join(dir, "onnx", "decoder_prefill_int8.onnx"), opts),
    stp: await ort.InferenceSession.create(join(dir, "onnx", "decoder_step_int8.onnx"), opts),
    charset,
    content,
  };
}

export async function loadPpocr(dir: string, opts: ort.InferenceSession.SessionOptions): Promise<Ppocr> {
  const dict = readFileSync(join(dir, "ppocrv6_dict.txt"), "utf8").split("\n");
  if (dict[dict.length - 1] === "") dict.pop();
  return {
    rec: await ort.InferenceSession.create(join(dir, "rec", "manga_rec_v0.2.onnx"), opts),
    vocab: ["", ...dict.map((l) => l.replace(/\r$/, "")), " "],
  };
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export async function readBaberu(m: Baberu, rgba: Uint8Array): Promise<string> {
  const plane = 224 * 224;
  const px = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++)
    for (let c = 0; c < 3; c++) px[c * plane + p] = (rgba[p * 4 + c]! / 255 - MEAN[c]!) / STD[c]!;
  const vis = await m.vis.run({ pixel_values: new ort.Tensor("float32", px, [1, 3, 224, 224]) });
  const embeds = vis.vision_embeds!;
  let out = await m.pre.run({
    vision_embeds: embeds,
    input_ids: new ort.Tensor("int64", BigInt64Array.from([1n]), [1, 1]),
  });
  const V = out.logits!.dims[2]!;
  let logits = Float64Array.from(
    (out.logits!.data as Float32Array).subarray((out.logits!.dims[1]! - 1) * V),
  );
  const seq = new Set<number>([1]);
  const toks: number[] = [];
  let pos = embeds.dims[1]! + 1;
  for (let n = 0; n < 256; n++) {
    for (const t of seq) logits[t] = logits[t]! < 0 ? logits[t]! * 1.2 : logits[t]! / 1.2;
    const last = toks[toks.length - 1] ?? 0;
    const cap = m.content.has(last) ? 12 : last > 3 ? 16 : 0;
    if (cap) {
      let run = 0;
      for (let i = toks.length - 1; i >= 0 && toks[i] === last; i--) run++;
      if (run >= cap) logits[last] = -Infinity;
    }
    let best = 0;
    for (let i = 1; i < V; i++) if (logits[i]! > logits[best]!) best = i;
    if (best === 2) break;
    toks.push(best);
    seq.add(best);
    const feed: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(best)]), [1, 1]),
      position_ids: new ort.Tensor("int64", BigInt64Array.from([BigInt(pos)]), [1, 1]),
    };
    for (const name of Object.keys(out)) {
      if (name.startsWith("present_")) feed[name.replace("present_", "past_")] = out[name]!;
    }
    out = await m.stp.run(feed);
    logits = Float64Array.from(out.logits!.data as Float32Array);
    pos++;
  }
  return toks.map((t) => (t >= 4 ? m.charset[t - 4] ?? "" : "")).join("");
}

/** One line crop through the CTC recognizer: height 48, natural width
    (16..640, up to 2400 for very long lines); vertical lines turn 90° CCW
    first, as the model was trained. */
export async function readPpocr(
  m: Ppocr,
  px: PixelSource,
  rect: Rect,
  vertical: boolean,
): Promise<string> {
  const along = vertical ? rect.sh : rect.sw;
  const across = vertical ? rect.sw : rect.sh;
  const natural = Math.round((48 * along) / Math.max(1, across));
  const W = Math.max(16, Math.min(natural > 2000 ? 2400 : 640, natural));
  // Resample unrotated (48 across × W along), then rotate in JS.
  const [rgba] = vertical ? await px.rgba([rect], 48, W) : await px.rgba([rect], W, 48);
  const data = new Float32Array(3 * 48 * W);
  const plane = 48 * W;
  for (let y = 0; y < 48; y++)
    for (let x = 0; x < W; x++) {
      // Rotated CCW: output (x, y) reads source (sx = 47 - y, sy = x) of the
      // 48-wide, W-tall resample.
      const si = vertical ? (x * 48 + (47 - y)) * 4 : (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        // BGR, (v/255 - 0.5) / 0.5
        data[c * plane + y * W + x] = rgba![si + (2 - c)]! / 127.5 - 1;
      }
    }
  const out = await m.rec.run({ x: new ort.Tensor("float32", data, [1, 3, 48, W]) });
  const logits = Object.values(out)[0]!;
  const T = logits.dims[1]!;
  const C = logits.dims[2]!;
  const ld = logits.data as Float32Array;
  let text = "";
  let prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0;
    for (let c = 1; c < C; c++) if (ld[t * C + c]! > ld[t * C + best]!) best = c;
    if (best !== 0 && best !== prev) text += m.vocab[best] ?? "";
    prev = best;
  }
  return text.trim();
}
