// Line splitting for the recognize march: manga-ocr reads a whole block at
// 224², so a dense block of N columns leaves each glyph a sliver of the
// encoder's input. Splitting the block into its lines (vertical columns,
// horizontal rows) and reading each line on its own gives every glyph the
// full crop. Pure pixel math over a grayscale view of the block — no
// model, no canvas: the worker and the node harness share it.

import {
  MERGE_GAP,
  bands,
  cutPoints,
  dropRuby,
  foldNarrow,
  trimRuby,
  inkMask,
  lineExtent,
  mergeClose,
  profileAcross,
  splitMerged,
  typicalWidth,
  type Band,
  type Gray,
  type RubyMode,
} from "./lines-profile";

export { grayFromRgba, inkMask, type Gray, type RubyMode } from "./lines-profile";

/** A crop to read, in the coordinates of the Gray it was found in. */
export interface LineRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface LineSplit {
  /** Columns (true) or one row cut into chunks (false) — the block's real
      orientation, which may overrule its aspect. */
  vertical: boolean;
  /** Lines in reading order (vertical: right→left); each line is one or
      more chunks in reading order whose texts concatenate. */
  lines: LineRect[][];
}

export interface SplitOptions {
  ruby?: RubyMode;
  /** Read line by line only when a glyph of the whole-block crop would get
      fewer encoder pixels than this (default SPLIT_BELOW_PX). */
  splitBelowPx?: number;
}

/** When to read line by line, measured on whole volumes (かぐや様, 推しの子)
    by the size a glyph gets once the whole (padded) block is squeezed to
    the encoder's 224²: under 12px line-by-line fixes hundreds of
    characters, 12–18px still a few, while from 18px up manga-ocr reads the
    block better whole (it was trained on whole bubbles) and line crops only
    add stray marks at line ends. */
const SPLIT_BELOW_PX = 18;
/** The recognizer's input side, and the block crop's padding share. */
const CROP_SIZE = 224;
const CROP_PAD = 0.08;
/** Padding around a line crop, as a share of its width. */
const PAD = 0.15;
/** The lines (plus ink set aside on purpose) must hold this share of the
    block's ink, or the split missed something (a short line, a stray
    glyph) and the block reads whole. */
const MIN_COVERAGE = 0.97;

/** Text strokes cover well under half of their line's box; a band that is
    mostly ink is art (a bubble tail, a speed-line wedge), not a line —
    heavy display type stays under ~0.45 averaged over a whole line. */
const MAX_FILL = 0.6;
/** A one-glyph edge band thinner than this fill is an outline arc. */
const ARC_FILL = 0.2;
/** An edge band with less than this share of a typical line's ink is not
    a line of text (ruby, an outline fragment, a stray tick). */
const EDGE_INK = 0.3;
/** An edge band narrower than this share of a typical line is ruby or a
    stroke (ruby kana run ~half width); a short line of real glyphs is
    wider even in narrow kana (でも measured 0.8). */
const EDGE_NARROW = 0.7;
/** Columns that overrule a wide block's aspect hold several glyphs. */
const WIDE_COLUMNS = 2.5;
/** Lines hold two-plus glyphs on average; glyph cells are ~square. */
const MIN_ELONGATION = 1.5;

interface Layout {
  lines: Band[];
  extents: { a: number; b: number; profile: Float64Array }[];
  /** Ruby left out of the lines: crops keep clear of it. */
  dropped: Band[];
  /** Ink per position across the lines (columns: per x, rows: per y). */
  across: Float64Array;
  /** Median gap BETWEEN lines over the median blank run INSIDE a line:
      real lines sit farther apart than their glyphs do, while reading a
      block the wrong way round turns column gaps into "inner" gaps. */
  gapRatio: number;
  /** Median gap between lines over the typical line width: real lines are
      spaced a good share of a glyph apart, glyph cells barely at all. */
  spacing: number;
  /** Median line length over line width: lines hold several glyphs, the
      glyph cells of the other axis are ~square. */
  elongation: number;
}

function layout(mask: Uint8Array, w: number, h: number, vertical: boolean, ruby: RubyMode): Layout | null {
  const length = vertical ? h : w;
  const across = profileAcross(mask, w, h, vertical);
  // A position belongs to a line when a few percent of the line's length
  // carries ink there; gaps between lines carry next to none.
  const raw = bands(across, Math.max(1, length * 0.01), 2);
  if (raw.length === 0) return null;
  let typical = typicalWidth(raw);
  const dropped: Band[] = [];
  const unruby = dropRuby(raw, vertical, ruby, typical, dropped);
  let list = splitMerged(mergeClose(unruby, Math.max(2, typical * MERGE_GAP)), across, typical);
  if (ruby === "drop") list = trimRuby(list, across, vertical, typical, dropped);
  typical = typicalWidth(list);
  list = foldNarrow(list, vertical, typical, dropped);
  const lines: Band[] = [];
  const extents: Layout["extents"] = [];
  for (const band of list) {
    const ext = lineExtent(mask, w, h, band, vertical);
    if (!ext) continue;
    let ink = 0;
    for (let i = ext.a; i < ext.b; i++) ink += ext.profile[i]!;
    if (ink > (band.b - band.a) * (ext.b - ext.a) * MAX_FILL) continue;
    lines.push(band);
    extents.push(ext);
  }
  // The edges of a block collect what is not text: a bubble's outline
  // clipping a corner (a thin one-glyph arc the recognizer reads as ノ or
  // ん), ruby beside the first line (じっか read ahead of 実家), a stray
  // tick read as 、. Such an edge band is narrower than a line (small kana,
  // a thin stroke) and light or short next to the real lines. A short line
  // of full-size glyphs is real text — でも opening a bubble, ね closing it.
  // The first line (rightmost column, top row) goes when narrow and light
  // or short; the last one only when narrow and light.
  const inkOf = (i: number) => {
    let ink = 0;
    for (let k = extents[i]!.a; k < extents[i]!.b; k++) ink += extents[i]!.profile[k]!;
    return ink;
  };
  const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);
  if (lines.length >= 3) {
    const medInk = sorted(lines.map((_, i) => inkOf(i)))[lines.length >> 1]!;
    const medLen = sorted(extents.map((e) => e.b - e.a))[lines.length >> 1]!;
    const first = vertical ? lines.length - 1 : 0;
    const last = vertical ? 0 : lines.length - 1;
    const light = (i: number) => inkOf(i) < medInk * EDGE_INK;
    const narrow = (i: number) => lines[i]!.b - lines[i]!.a < typical * EDGE_NARROW;
    const short = (i: number) => extents[i]!.b - extents[i]!.a < medLen * 0.4;
    const drop = new Set<number>();
    if (narrow(first) && (light(first) || short(first))) drop.add(first);
    if (light(last) && narrow(last)) drop.add(last);
    for (const i of [...drop].sort((x, y) => y - x)) {
      dropped.push(lines[i]!);
      lines.splice(i, 1);
      extents.splice(i, 1);
    }
  }
  for (const edge of [lines.length - 1, 0]) {
    if (lines.length < 2) break;
    const band = lines[edge]!;
    const ext = extents[edge]!;
    const width = band.b - band.a;
    const length = ext.b - ext.a;
    if (length <= width * 1.2 && inkOf(edge) < width * length * ARC_FILL) {
      dropped.push(band);
      lines.splice(edge, 1);
      extents.splice(edge, 1);
    }
  }
  if (lines.length === 0) return null;
  const between: number[] = [];
  for (let i = 1; i < lines.length; i++) between.push(lines[i]!.a - lines[i - 1]!.b);
  const inner: number[] = [];
  extents.forEach((ext) => {
    let run = 0;
    for (let i = ext.a; i < ext.b; i++) {
      if (ext.profile[i] === 0) run++;
      else if (run > 0) {
        inner.push(run);
        run = 0;
      }
    }
  });
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1] ?? 0;
  return {
    lines,
    extents,
    dropped,
    across,
    gapRatio: median(between) / Math.max(1, median(inner)),
    spacing: median(between) / Math.max(1, typicalWidth(lines)),
    elongation: median(lines.map((band, i) => (extents[i]!.b - extents[i]!.a) / Math.max(1, band.b - band.a))),
  };
}

/** Split a block into its lines. `g` is the block's region (no padding).
    Orientation comes from the gaps, not from the block's aspect: manga
    packs short vertical columns into wide bubbles, and reading those as
    rows interleaves the columns — measured as the worst failure. Real
    lines sit farther apart than their glyphs, so the reading whose
    between-line gaps beat its inner gaps (and the other reading's) wins;
    a single long line is cut into chunks. Returns null when the block
    should be read whole: glyphs that keep enough pixels in the whole-block
    crop, lines that are not line-shaped, or crops that would miss part of
    the ink. Rects may reach past the region by their padding — the caller
    clamps them to the page. */
export function splitLines(
  g: Gray,
  verticalHint: boolean,
  { ruby = "drop", splitBelowPx = SPLIT_BELOW_PX }: SplitOptions = {},
): LineSplit | null {
  const { width: w, height: h } = g;
  if (w < 8 || h < 8) return null;
  const mask = inkMask(g);
  const cols = layout(mask, w, h, true, ruby);
  const rows = layout(mask, w, h, false, ruby);
  // Lines are several, longer than wide, and set farther apart than their
  // glyphs. Rows only count in a block that is not tall (manga paragraphs
  // are wide; a tall block read as rows interleaves its columns). Columns
  // in a wide block must be truly long: a horizontal title with ruby
  // above looks like a row of glyph+ruby "columns" and would read
  // backwards. When both readings qualify, the wider line spacing wins.
  const lined = (x: Layout | null): x is Layout =>
    !!x && x.lines.length >= 2 && x.elongation >= MIN_ELONGATION && x.gapRatio > 1;
  const rowsOk = lined(rows) && !verticalHint;
  const colsOk = lined(cols) && (verticalHint || cols.elongation >= WIDE_COLUMNS);
  let vertical: boolean;
  let pick: Layout;
  if (colsOk && (!rowsOk || cols.spacing >= rows!.spacing)) {
    vertical = true;
    pick = cols;
  } else if (rowsOk) {
    vertical = false;
    pick = rows!;
  } else {
    // One line along the block's long side — the only shape left to cut.
    vertical = verticalHint;
    const one = vertical ? cols : rows;
    if (!one || one.lines.length !== 1) return null;
    pick = one;
  }
  const { lines, extents } = pick;
  // The glyph's share of the whole-block crop (padded like cropRect) after
  // the squeeze to 224²: a big enough glyph reads better whole.
  const side = Math.max(w, h) + 2 * Math.max(4, Math.min(w, h) * CROP_PAD);
  if ((CROP_SIZE * typicalWidth(lines)) / side >= splitBelowPx) return null;
  // Coverage: the line bodies plus what was set aside on purpose (ruby,
  // outline fragments, specks) must account for the block's ink — a short
  // closing line the band finder missed must never vanish silently.
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i]!;
  let covered = 0;
  extents.forEach((ext) => {
    for (let i = ext.a; i < ext.b; i++) covered += ext.profile[i]!;
  });
  for (const band of pick.dropped) {
    for (let i = band.a; i < band.b; i++) covered += pick.across[i]!;
  }
  if (covered < total * MIN_COVERAGE) return null;
  const alongMax = vertical ? h : w;
  const out: LineRect[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const band = lines[i]!;
    const ext = extents[i]!;
    const width = band.b - band.a;
    const pad = Math.round(width * PAD) + 2;
    // Pad across only over blank positions and never into a neighbour
    // (a line or dropped ruby — at most half the gap): a stray stroke
    // beside the line, even ruby too faint to form a band, stays out.
    const left = [...lines.slice(0, i), ...pick.dropped].filter((o) => o.b <= band.a);
    const right = [...lines.slice(i + 1), ...pick.dropped].filter((o) => o.a >= band.b);
    const before = left.length ? Math.floor((band.a - Math.max(...left.map((o) => o.b))) / 2) : pad;
    const after = right.length ? Math.floor((Math.min(...right.map((o) => o.a)) - band.b) / 2) : pad;
    let lo = 0;
    while (lo < Math.min(pad, Math.max(0, before)) && !pick.across[band.a - lo - 1]) lo++;
    let hi = 0;
    while (hi < Math.min(pad, Math.max(0, after)) && !pick.across[band.b + hi]) hi++;
    const across1 = band.a - lo;
    const across2 = band.b + hi;
    const cuts = cutPoints(ext.a, ext.b, width, ext.profile);
    const stops = [ext.a - pad, ...cuts, ext.b + pad];
    const pieces: LineRect[] = [];
    for (let k = 0; k + 1 < stops.length; k++) {
      const along1 = Math.max(-pad, stops[k]!);
      const along2 = Math.min(alongMax + pad, stops[k + 1]!);
      pieces.push(
        vertical
          ? { x1: across1, y1: along1, x2: across2, y2: along2 }
          : { x1: along1, y1: across1, x2: along2, y2: across2 },
      );
    }
    out.push(pieces);
  }
  // Reading order: vertical columns right→left, horizontal rows top→bottom.
  if (vertical) out.reverse();
  if (out.length === 1 && out[0]!.length === 1) return null;
  return { vertical, lines: out };
}
