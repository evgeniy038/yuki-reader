// OCR quality harness: runs the SHIPPED pipeline (src/core/ocr/ — same
// params; pixels resampled by a real headless Chrome canvas, exactly as the
// app's worker does) in Node over whole volumes, then scores it against a
// .mokuro sidecar and/or a vision-verified golden file. This is the
// quality gate: perf numbers live in ocr-smoke, accuracy lives here.
//
//   pnpm tsx tests/ocr-quality.ts --vol kaguya [--pages 6,7|all] \
//     [--models merged|q4f16|q8|fp32|l0] [--det full|fp16|s] [--dump] [--iou 0.2] \
//     [--canvas chrome|sharp] [--smoothing high|default|low|medium] \
//     [--no-gray] [--no-lines | --split-below 18] [--beams 4] [--conf 0.4] \
//     [--rec mocr|baberu|ppocr] [--tag name] \
//     [--mokuro path/to/other.mokuro] \
//     [--gate [--gate-recall 0.85] [--gate-cer 0.10] [--gate-runaway 0]]
//
// Defaults are the shipped wasm path (merged int8 decoder, full int8
// detector, "high" canvas smoothing, grayscale crops, line-by-line reads of
// dense blocks); `--models q4f16 --det fp16` is the shipped WebGPU path.
// Models come from YUKI_OCR_MODEL_DIR (default /tmp/yuki-ocr-models);
// YUKI_OCR_THREADS caps onnxruntime's intra-op threads; reports land in
// YUKI_OCR_QUALITY_OUT (default /tmp/ocr-quality) as report-<tag>.json.
//
// --dump writes every recognition crop + full pages under <out>/<tag>/ for
// vision review. --gate scores the run against tests/golden/<vol>.json (box
// match when the golden block has one, page-level text match when it
// doesn't; golden pages are found by image name) and exits 1 when recall /
// mean-CER / runaway-count breach the thresholds — the golden file's own
// `gate` (the shipped pipeline's scores plus a margin) unless overridden.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { openPixelSource } from "./ocr-quality-canvas.ts";
import { ocrPage, type OcrBlock, type PageTiming, type Sessions } from "./ocr-quality-pipeline.ts";
import { loadBaberu, loadPpocr } from "./ocr-quality-alt.ts";
import { comparePage, isRunaway, summarize, type PageReport, type RefBlock } from "./ocr-quality-score.ts";
import { VOLS } from "./ocr-quality-vols.ts";

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : dflt;
};
const VOL = opt("vol", "kaguya");
const PAGES_OPT = opt("pages", "all");
const MODELS = opt("models", "merged");
const DET = opt("det", "full");
const DUMP = args.includes("--dump");
const GATE = args.includes("--gate");
const MATCH_IOU = Number(opt("iou", "0.2"));
const CANVAS = opt("canvas", "chrome");
// Defaults are the shipped pipeline; the flags switch a stage OFF for A/B.
const SMOOTHING = opt("smoothing", "high");
const GRAY = !args.includes("--no-gray");
const LINES = !args.includes("--no-lines");
const BEAMS = Number(opt("beams", "1"));
const REC = opt("rec", "mocr") as "mocr" | "baberu" | "ppocr";
const SPLIT_BELOW = args.includes("--split-below") ? Number(opt("split-below", "18")) : undefined;
const CONF = args.includes("--conf") ? Number(opt("conf", "0.35")) : undefined;

// ---------- models ----------
const MODEL_DIR = process.env.YUKI_OCR_MODEL_DIR ?? "/tmp/yuki-ocr-models";
const THREADS = Number(process.env.YUKI_OCR_THREADS ?? 0);
const MODEL_SETS: Record<string, { enc: string; dec: string; vocab: string }> = {
  q8: { enc: "encoder_q8.onnx", dec: "decoder_q8.onnx", vocab: "vocab.txt" },
  merged: { enc: "encoder_q8.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  q4f16: { enc: "encoder_model_q4f16.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  fp32: { enc: "encoder_fp32.onnx", dec: "decoder_fp32.onnx", vocab: "vocab.txt" },
  l0: { enc: "l0_encoder.onnx", dec: "l0_decoder.onnx", vocab: "vocab.txt" },
  // Precision A/B: one half at fp32/fp16, the other as shipped.
  enc32: { enc: "encoder_fp32.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  encf16: { enc: "encoder_fp16.onnx", dec: "decoder_model_merged_batch_int8.onnx", vocab: "vocab.txt" },
  dec32: { enc: "encoder_q8.onnx", dec: "decoder_fp32.onnx", vocab: "vocab.txt" },
};
const DETECTORS: Record<string, string> = {
  s: "detector-v4-s_int8.onnx",
  full: "detector_int8.onnx",
  // The shipped WebGPU build: fp16 conversion of the fp32 export. On CPU
  // (this harness runs onnxruntime-node) it is slower than int8 but the
  // boxes are what the browser's GPU actually produces.
  fp16: "detector_fp16.onnx",
};

// ---------- main ----------
const vol = VOLS[VOL];
if (!vol) throw new Error(`unknown vol ${VOL} (have ${Object.keys(VOLS).join(", ")})`);
const tag = opt("tag", `${VOL}-${MODELS}-${DET}`);
const OUT_ROOT = process.env.YUKI_OCR_QUALITY_OUT ?? "/tmp/ocr-quality";
const OUT = join(OUT_ROOT, tag);
mkdirSync(OUT, { recursive: true });
if (DUMP) mkdirSync(join(OUT, "crops"), { recursive: true });

const pages = vol.images();
const missing = pages.filter((p) => !p.buf).length;
console.log(`volume ${VOL}: ${pages.length} pages${missing ? ` (${missing} missing on disk, skipped)` : ""}`);
const pageIdxs =
  PAGES_OPT === "all"
    ? pages.map((_, i) => i)
    : PAGES_OPT.split(",").map(Number);

// Mokuro pages are matched by image file name, never by index: a sidecar
// may list pages the folder no longer has (and vice versa).
type MokuroRefPage = { img_path: string; blocks: { box: number[]; lines: string[]; vertical?: boolean }[] };
const mokuroPath = opt("mokuro", vol.mokuro ?? "");
const refByName: Map<string, MokuroRefPage> | null =
  mokuroPath && existsSync(mokuroPath)
    ? new Map(
        (JSON.parse(readFileSync(mokuroPath, "utf8")) as { pages: MokuroRefPage[] }).pages.map(
          (p) => [basename(p.img_path), p],
        ),
      )
    : null;
type GoldenFile = {
  /** The volume's own gate: the shipped pipeline's measured scores plus a
      margin. CLI flags override. */
  gate?: { recall?: number; cer?: number; runaways?: number };
  pages: { page: number; img?: string; blocks: { box: number[] | null; text: string; src?: string }[] }[];
};
const golden: GoldenFile | null =
  vol.golden && existsSync(vol.golden)
    ? JSON.parse(readFileSync(vol.golden, "utf8"))
    : null;
console.log(`reference: ${refByName ? "mokuro" : "none"}, golden: ${golden ? "yes" : "none"}`);
const GATE_RECALL = Number(opt("gate-recall", String(golden?.gate?.recall ?? 0.85)));
const GATE_CER = Number(opt("gate-cer", String(golden?.gate?.cer ?? 0.1)));
const GATE_RUNAWAY = Number(opt("gate-runaway", String(golden?.gate?.runaways ?? 0)));

const set = MODEL_SETS[MODELS]!;
const sessionOpts: ort.InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  ...(THREADS > 0 ? { intraOpNumThreads: THREADS } : {}),
};
const [detSession, encSession, decSession] = await Promise.all([
  ort.InferenceSession.create(join(MODEL_DIR, DETECTORS[DET]!), sessionOpts),
  ort.InferenceSession.create(join(MODEL_DIR, set.enc), sessionOpts),
  ort.InferenceSession.create(join(MODEL_DIR, set.dec), sessionOpts),
]);
const sessions: Sessions = {
  det: detSession,
  enc: encSession,
  dec: decSession,
  vocab: readFileSync(join(MODEL_DIR, set.vocab), "utf8").split("\n"),
};
const ALT_DIR = process.env.YUKI_OCR_ALT_DIR ?? join(MODEL_DIR, "alt");
if (REC === "baberu") sessions.baberu = await loadBaberu(join(ALT_DIR, "baberu"), sessionOpts);
if (REC === "ppocr") sessions.ppocr = await loadPpocr(join(ALT_DIR, "ppocr"), sessionOpts);
const px = await openPixelSource(CANVAS, SMOOTHING === "default" ? null : SMOOTHING);
// The line recognizer only reads lines.
const options = { gray: GRAY, lines: LINES || REC === "ppocr", beams: BEAMS, rec: REC, splitBelowPx: SPLIT_BELOW, conf: CONF };
console.log(
  `sessions ready (det ${DET}, models ${MODELS}, canvas ${CANVAS}/${SMOOTHING}` +
    `${GRAY ? ", gray" : ""}${options.lines ? ", lines" : ""}${BEAMS > 1 ? `, beams ${BEAMS}` : ""}` +
    `${REC !== "mocr" ? `, rec ${REC}` : ""}${CONF !== undefined ? `, conf ${CONF}` : ""})`,
);

// Two separate scorecards: every page vs its .mokuro page (broad, but the
// reference is itself an OCR run), and the golden pages vs the vision-
// verified golden blocks (narrow, but true) — the gate reads the latter.
const reports: PageReport[] = [];
const goldReports: PageReport[] = [];
// Pages with neither reference: no score, but their blocks are kept for the
// runaway count and for side-by-side review of two runs.
const unrefReports: { page: number; img: string; all: OcrBlock[] }[] = [];
const timing: PageTiming = { detect: 0, split: 0, crop: 0, enc: 0, dec: 0, crops: 0 };
let totalMs = 0;
for (const pi of pageIdxs) {
  const page = pages[pi];
  if (!page?.buf) continue;
  const t0 = performance.now();
  const { width: w, height: h } = await px.page(page.buf);
  const ours = await ocrPage(sessions, px, page.buf, w, h, options, timing);
  const ms = performance.now() - t0;
  totalMs += ms;
  if (DUMP) {
    writeFileSync(join(OUT, `page-${pi}.jpg`), await sharp(page.buf).jpeg({ quality: 80 }).toBuffer());
    for (const [bi, b] of ours.entries()) {
      for (const [ci, r] of b.crops.entries()) {
        await sharp(page.buf)
          .extract({ left: r.sx, top: r.sy, width: r.sw, height: r.sh })
          .png()
          .toFile(join(OUT, "crops", `p${pi}-b${bi}-c${ci}.png`));
      }
    }
  }
  const refPage = refByName?.get(page.name);
  if (refPage) {
    const ref: RefBlock[] = refPage.blocks.map((b) => ({
      x1: b.box[0]!, y1: b.box[1]!, x2: b.box[2]!, y2: b.box[3]!,
      text: b.lines.join(""),
    }));
    reports.push(comparePage(pi, page.name, ours, ref, MATCH_IOU));
  }
  // Golden pages, like mokuro's, are found by image name (the page index is
  // only a fallback for golden pages written without one): a folder that
  // loses or gains a file must not shift the truth onto other pages.
  const goldPage = golden?.pages.find((g) => (g.img ? g.img === page.name : g.page === pi));
  if (goldPage) {
    const gold: RefBlock[] = goldPage.blocks.map((b) =>
      b.box
        ? { x1: b.box[0]!, y1: b.box[1]!, x2: b.box[2]!, y2: b.box[3]!, text: b.text }
        : { text: b.text },
    );
    goldReports.push(comparePage(pi, page.name, ours, gold, MATCH_IOU));
  }
  if (!refPage && !goldPage) unrefReports.push({ page: pi, img: page.name, all: ours });
  const r = refPage ? reports[reports.length - 1]! : goldPage ? goldReports[goldReports.length - 1]! : null;
  console.log(
    r
      ? `p${pi} ${page.name}: ours ${r.ours} ref ${r.ref} matched ${r.matched} ` +
          `miss ${r.missed.length} extra ${r.extra.length} CER ${r.meanCer.toFixed(3)} (${(ms / 1000).toFixed(1)}s)`
      : `p${pi} ${page.name}: ours ${ours.length} (no reference) (${(ms / 1000).toFixed(1)}s)`,
  );
}
await px.close();

const ocrPages = pageIdxs.filter((pi) => pages[pi]?.buf).length;
const msPerPage = totalMs / Math.max(1, ocrPages);
const mok = summarize(reports);
const gold = summarize(goldReports);
const allDiffs = reports.flatMap((r) => r.diffs.map((d) => ({ ...d, page: r.page })));

const per = (v: number) => (v / Math.max(1, ocrPages)).toFixed(0);
console.log(`\n=== ${tag} over ${ocrPages} pages, ${msPerPage.toFixed(0)} ms/page ===`);
console.log(
  `per page: detect ${per(timing.detect)} | split ${per(timing.split)} | crop ${per(timing.crop)} | ` +
    `enc ${per(timing.enc)} | dec ${per(timing.dec)} ms | crops ${(timing.crops / Math.max(1, ocrPages)).toFixed(1)}`,
);
if (reports.length) {
  console.log(
    `vs mokuro (${mok.pages} pages): ours ${mok.ours} | ref ${mok.ref} | matched ${mok.matched} | ` +
      `missed ${mok.missed} | extra ${mok.extra} | recall ${mok.recall.toFixed(3)} | ` +
      `mean CER ${mok.meanCer.toFixed(4)} | runaways ${mok.runaways} | diffs >8%: ${allDiffs.length}`,
  );
}
if (goldReports.length) {
  console.log(
    `vs golden (${gold.pages} pages): ref ${gold.ref} | matched ${gold.matched} | ` +
      `recall ${gold.recall.toFixed(3)} | mean CER ${gold.meanCer.toFixed(4)} | runaways ${gold.runaways}`,
  );
}
if (unrefReports.length) {
  const blocks = unrefReports.flatMap((r) => r.all);
  console.log(
    `no reference (${unrefReports.length} pages): ours ${blocks.length} | ` +
      `runaways ${blocks.filter((b) => isRunaway(b.text)).length}`,
  );
}
allDiffs
  .sort((a, b) => b.cer - a.cer)
  .slice(0, 30)
  .forEach((d) =>
    console.log(`  p${d.page} CER ${d.cer.toFixed(2)} IoU ${d.iou.toFixed(2)}\n    ours: ${d.ours}\n    ref:  ${d.ref}`),
  );
const reportPath = join(OUT_ROOT, `report-${tag}.json`);
writeFileSync(
  reportPath,
  JSON.stringify({ tag, msPerPage, timing, mokuro: mok, golden: gold, reports, goldReports, unrefReports }, null, 2),
);
console.log(`report: ${reportPath}`);

// ---------- quality gate (--gate): verdict against the golden file ----------
if (GATE) {
  if (!golden) {
    console.error("gate: no golden file for this volume");
    process.exitCode = 2;
  } else {
    const runaways = goldReports.flatMap((r) =>
      r.all.filter((b) => isRunaway(b.text)).map((b) => ({ page: r.page, text: b.text })),
    );
    const checks = [
      { name: `recall ${gold.recall.toFixed(3)} >= ${GATE_RECALL}`, ok: gold.recall >= GATE_RECALL },
      { name: `meanCER ${gold.meanCer.toFixed(4)} <= ${GATE_CER}`, ok: gold.meanCer <= GATE_CER },
      { name: `runaways ${runaways.length} <= ${GATE_RUNAWAY}`, ok: runaways.length <= GATE_RUNAWAY },
    ];
    console.log(`\n=== GATE (${VOL}, ${gold.pages} golden pages, ${gold.ref} blocks) ===`);
    for (const c of checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
    for (const r of runaways.slice(0, 5))
      console.log(`  runaway p${r.page}: ${r.text.slice(0, 60)}…`);
    const failed = checks.filter((c) => !c.ok);
    console.log(failed.length ? `GATE: FAIL (${failed.length} criteria)` : "GATE: PASS");
    process.exitCode = failed.length ? 1 : 0;
  }
}
