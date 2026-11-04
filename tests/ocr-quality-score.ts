// Scoring for the OCR quality harness: block matching (IoU, or text for
// box-less golden blocks, plus split recovery) and normalized CER.
import { iou, type Box, type OcrBlock } from "./ocr-quality-pipeline.ts";

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

export const norm = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[、。．.！？!?・…ー〜~「」『』（）()【】〈〉《》◆★☆：:]/g, "");
export const cer = (a: string, b: string): number =>
  levenshtein(norm(a), norm(b)) / Math.max(1, norm(b).length);

// Decoder runaway: the model looping on texture, not real text — one glyph
// 20+ times in a row (real sfx runs stay under that), a 2–4-glyph cycle
// repeated 10+ times (第条第条…, それは、それは、…) or a phrase of 5–12
// glyphs 4+ times (論バランスは勿論論バランスは勿論…). Length alone is no
// sign: a line-by-line read of a dense paragraph is legitimately long, and
// neither are dot runs — a table of contents' leader dots are real.
const DOTS = /^[.．・…。、‥]+$/u;
export const isRunaway = (t: string): boolean => {
  const loop = /(.)\1{19,}/u.exec(t) ?? /(.{2,4})\1{9,}/u.exec(t) ?? /(.{5,12})\1{3,}/u.exec(t);
  return !!loop && !DOTS.test(loop[1]!);
};

// A ref block may have no box (text-only golden): then it matches any unused
// ours block on the same page with normalized CER <= TEXT_MATCH_CER.
const TEXT_MATCH_CER = 0.2;
export interface RefBlock extends Partial<Box> {
  text: string;
}
export interface PageReport {
  page: number;
  img: string;
  ours: number;
  ref: number;
  matched: number;
  missed: RefBlock[];
  extra: OcrBlock[];
  diffs: { ours: string; ref: string; cer: number; box: number[]; iou: number }[];
  /** Every matched pair, for block-by-block A/B diffs between runs. */
  pairs: { ref: string; ours: string; cer: number; box: number[] }[];
  meanCer: number;
  all: OcrBlock[];
}

export function comparePage(
  page: number,
  img: string,
  ours: OcrBlock[],
  ref: RefBlock[],
  matchIou: number,
): PageReport {
  const diffs: PageReport["diffs"] = [];
  const pairs: PageReport["pairs"] = [];
  const missed: RefBlock[] = [];
  const used = new Set<number>();
  let cerSum = 0;
  let matched = 0;
  const refBox = (rb: RefBlock, fallback: Box): number[] =>
    rb.x1 !== undefined
      ? [rb.x1!, rb.y1!, rb.x2!, rb.y2!].map(Math.round)
      : [fallback.x1, fallback.y1, fallback.x2, fallback.y2].map(Math.round);
  const record = (rb: RefBlock, text: string, c: number, v: number, at: Box) => {
    matched++;
    cerSum += c;
    pairs.push({ ref: rb.text, ours: text, cer: c, box: refBox(rb, at) });
    if (c > 0.08) diffs.push({ ours: text, ref: rb.text, cer: c, iou: v, box: refBox(rb, at) });
  };
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
    const ok = hasBox ? bestIou >= matchIou : bestCer <= TEXT_MATCH_CER;
    if (ok && bestIdx >= 0) {
      used.add(bestIdx);
      record(rb, ours[bestIdx]!.text, cer(ours[bestIdx]!.text, rb.text), hasBox ? bestIou : -1, ours[bestIdx]!);
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
          const union = { x1: ux1, y1: uy1, x2: ux2, y2: uy2 };
          const v = iou(rb as Box, union);
          if (v >= matchIou) {
            const text = grp.map((g) => ours[g]!.text).join("");
            const c = cer(text, rb.text);
            if (c <= TEXT_MATCH_CER) {
              for (const g of grp) used.add(g);
              record(rb, text, c, v, union);
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
    missed, extra, diffs, pairs,
    meanCer: matched > 0 ? cerSum / matched : 0,
    all: ours,
  };
}

export function summarize(rs: PageReport[]) {
  const matched = rs.reduce((s, r) => s + r.matched, 0);
  const ref = rs.reduce((s, r) => s + r.ref, 0);
  return {
    pages: rs.length,
    ours: rs.reduce((s, r) => s + r.ours, 0),
    ref,
    matched,
    missed: rs.reduce((s, r) => s + r.missed.length, 0),
    extra: rs.reduce((s, r) => s + r.extra.length, 0),
    recall: matched / Math.max(1, ref),
    meanCer: rs.reduce((s, r) => s + r.meanCer * r.matched, 0) / Math.max(1, matched),
    // Volume-wide runaways: every block we produced, matched or not.
    runaways: rs.flatMap((r) => r.all.filter((b) => isRunaway(b.text))).length,
  };
}
