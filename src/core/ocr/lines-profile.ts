// Ink-profile primitives for the line splitter (lines.ts): the luma
// raster, its Otsu ink mask, per-axis ink profiles and the bands they form
// — merged across hairline gaps, split where two lines touch, ruby folded
// into its line — plus a line's own extent and its chunk cuts. Pure pixel
// math, no model, no canvas.

/** 8-bit luma raster of a page region, row-major. */
export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Ruby beside a line: "drop" leaves it out of the line's crop — read
    alone, a single column hands its furigana to the recognizer as text
    (じっか実家に…), which manga-ocr only skips inside a whole bubble;
    "fold" keeps it inside the crop. */
export type RubyMode = "fold" | "drop";

/** Lines longer than this many line-widths are read in chunks. */
const MAX_RATIO = 16;
/** A band narrower than this share of the typical line is ruby or
    punctuation: it rides with its neighbour instead of being read alone. */
const NARROW = 0.6;
/** Bands closer than this share of the typical line are one band (glyphs
    like 川 or い leave hairline gaps inside a column). */
export const MERGE_GAP = 0.12;
/** A band this many typical widths wide is two lines that touch. */
const MERGED = 1.7;
/** A band this many typical widths wide may be a line with its ruby glued
    on. */
const GLUED = 1.2;
/** A band at least this share of the typical line is a full line (a base
    that ruby can sit beside). */
const FULL = 0.75;

/** Otsu threshold of the region's histogram. */
function otsu(g: Gray): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]!]! += 1;
  const total = g.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t]!;
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/** Ink mask (1 = text stroke): dark-on-light by Otsu; a region that comes
    out mostly "ink" is light text on a dark ground and flips. */
export function inkMask(g: Gray): Uint8Array {
  const t = otsu(g);
  const mask = new Uint8Array(g.data.length);
  let ink = 0;
  for (let i = 0; i < g.data.length; i++) {
    if (g.data[i]! <= t) {
      mask[i] = 1;
      ink++;
    }
  }
  if (ink > g.data.length / 2) for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i]!;
  return mask;
}

export interface Band {
  a: number;
  b: number; // exclusive
  mass: number;
}

/** Runs of a profile above `floor`, merged across gaps < mergeGap, specks
    (under 2% of the ink) dropped. */
export function bands(profile: Float64Array, floor: number, mergeGap: number): Band[] {
  const raw: Band[] = [];
  let start = -1;
  let mass = 0;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i]! > floor;
    if (on) {
      if (start < 0) {
        start = i;
        mass = 0;
      }
      mass += profile[i]!;
    } else if (start >= 0) {
      raw.push({ a: start, b: i, mass });
      start = -1;
    }
  }
  const merged = mergeClose(raw, mergeGap);
  const total = merged.reduce((s, b) => s + b.mass, 0);
  return merged.filter((b) => b.mass >= total * 0.02);
}

export function mergeClose(list: Band[], gap: number): Band[] {
  const out: Band[] = [];
  for (const band of list) {
    const last = out[out.length - 1];
    if (last && band.a - last.b < gap) {
      last.b = band.b;
      last.mass += band.mass;
    } else out.push({ ...band });
  }
  return out;
}

/** Ink profile across the line axis: per column (vertical text) or per row. */
export function profileAcross(mask: Uint8Array, w: number, h: number, vertical: boolean): Float64Array {
  const p = new Float64Array(vertical ? w : h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (mask[y * w + x]) p[vertical ? x : y]!++;
  return p;
}

/** The typical line width: the ink-weighted median band width, so a few
    ruby slivers or one fat merged band cannot drag it. */
export function typicalWidth(list: Band[]): number {
  const sorted = [...list].sort((x, y) => x.b - x.a - (y.b - y.a));
  const half = sorted.reduce((s, b) => s + b.mass, 0) / 2;
  let acc = 0;
  for (const band of sorted) {
    acc += band.mass;
    if (acc >= half) return Math.max(1, band.b - band.a);
  }
  return 1;
}

/** Split a band that is two-plus lines wide at its emptiest inner
    positions (columns set so tight their gap vanished in the profile). */
export function splitMerged(list: Band[], profile: Float64Array, typical: number): Band[] {
  const out: Band[] = [];
  for (const band of list) {
    const width = band.b - band.a;
    const n = Math.round(width / typical);
    if (width < typical * MERGED || n < 2) {
      out.push(band);
      continue;
    }
    let start = band.a;
    for (let k = 1; k < n; k++) {
      const ideal = Math.round(band.a + (width * k) / n);
      const lo = Math.max(start + 1, ideal - Math.round(typical / 3));
      const hi = Math.min(band.b - 1, ideal + Math.round(typical / 3));
      let cut = ideal;
      for (let i = lo; i <= hi; i++) if (profile[i]! < profile[cut]!) cut = i;
      let mass = 0;
      for (let i = start; i < cut; i++) mass += profile[i]!;
      out.push({ a: start, b: cut, mass });
      start = cut;
    }
    let mass = 0;
    for (let i = start; i < band.b; i++) mass += profile[i]!;
    out.push({ a: start, b: band.b, mass });
  }
  return out;
}

/** Ruby glued to its line (closer than the band finder's gap): a band
    1.2–1.7 typical widths wide whose profile dips near one typical width
    from its base side is a line plus its ruby — the ruby side (right of a
    column, above a row) is cut off and reported in `dropped`. */
export function trimRuby(
  list: Band[],
  profile: Float64Array,
  vertical: boolean,
  typical: number,
  dropped: Band[],
): Band[] {
  return list.map((band) => {
    const width = band.b - band.a;
    if (width < typical * GLUED || width >= typical * MERGED) return band;
    const body: number[] = [];
    for (let i = band.a; i < band.b; i++) body.push(profile[i]!);
    const level = body.sort((x, y) => x - y)[body.length >> 1]!;
    // Base side: a column's base is on the left, a row's below.
    const from = vertical ? band.a + Math.round(typical * 0.75) : band.b - Math.round(typical * 1.2);
    const to = vertical ? band.a + Math.round(typical * 1.2) : band.b - Math.round(typical * 0.75);
    let cut = -1;
    for (let i = Math.max(band.a + 1, from); i <= Math.min(band.b - 1, to); i++) {
      if (cut < 0 || profile[i]! < profile[cut]!) cut = i;
    }
    if (cut < 0 || profile[cut]! > level * 0.3) return band;
    const keep = vertical ? { a: band.a, b: cut } : { a: cut, b: band.b };
    const ruby = vertical ? { a: cut, b: band.b } : { a: band.a, b: cut };
    let mass = 0;
    for (let i = keep.a; i < keep.b; i++) mass += profile[i]!;
    dropped.push({ ...ruby, mass: band.mass - mass });
    return { ...keep, mass };
  });
}

/** Ruby beside its line, found BEFORE hairline merging (it sits a few
    pixels off its base, close enough to merge into it): a narrow band
    right of a full column (vertical text) or above a full row. "drop"
    takes it out of the bands and reports it in `dropped` (so line crops
    keep clear of it); "fold" leaves it for the merge to absorb. */
export function dropRuby(
  list: Band[],
  vertical: boolean,
  ruby: RubyMode,
  typical: number,
  dropped: Band[],
): Band[] {
  if (ruby === "fold") return list;
  const full = (b: Band) => b.b - b.a >= typical * FULL;
  const reach = typical * 0.6;
  return list.filter((band, i) => {
    if (band.b - band.a >= typical * NARROW) return true;
    // Ruby side: vertical → its base column is on the left (lower index);
    // horizontal → its base row is below (higher index).
    const base = list[vertical ? i - 1 : i + 1];
    if (!base || !full(base)) return true;
    const gap = vertical ? band.a - base.b : base.a - band.b;
    if (gap > reach) return true;
    dropped.push(band);
    return false;
  });
}

/** Fold narrow bands (a lone ！, ruby kept with "fold") into the adjacent
    full line — for vertical text the line on its left first, for
    horizontal the line below. A narrow band with nowhere to go is kept
    only when it carries real ink (a lone "！？" column); a faint stray (a
    bubble tail, a speck) is dropped. */
export function foldNarrow(
  list: Band[],
  vertical: boolean,
  typical: number,
  dropped: Band[] = [],
): Band[] {
  const out = list.map((b) => ({ ...b, narrow: b.b - b.a < typical * NARROW }));
  const reach = typical * 0.6;
  const mainMass = out.filter((b) => !b.narrow).map((b) => b.mass).sort((a, b) => a - b);
  const medianMain = mainMass[mainMass.length >> 1] ?? 0;
  for (let i = 0; i < out.length; i++) {
    const band = out[i]!;
    if (!band.narrow) continue;
    const order = vertical ? [i - 1, i + 1] : [i + 1, i - 1];
    let folded = false;
    for (const j of order) {
      const other = out[j];
      if (!other || other.narrow || other.mass < 0) continue;
      const gap = j < i ? band.a - other.b : other.a - band.b;
      if (gap > reach) continue;
      other.a = Math.min(other.a, band.a);
      other.b = Math.max(other.b, band.b);
      other.mass += band.mass;
      folded = true;
      break;
    }
    if (!folded && band.mass < medianMain * 0.25) dropped.push({ a: band.a, b: band.b, mass: band.mass });
    if (folded || band.mass < medianMain * 0.25) band.mass = -1;
  }
  return out.filter((b) => b.mass >= 0).map(({ a, b, mass }) => ({ a, b, mass }));
}

/** Ink profile along one band (per row for a column, per column for a
    row) and the extent of its body, ignoring stray specks separated from
    the body by more than 1.5 line widths. */
export function lineExtent(
  mask: Uint8Array,
  w: number,
  h: number,
  band: Band,
  vertical: boolean,
): { a: number; b: number; profile: Float64Array } | null {
  const length = vertical ? h : w;
  const profile = new Float64Array(length);
  if (vertical) {
    for (let y = 0; y < h; y++)
      for (let x = band.a; x < band.b; x++) profile[y]! += mask[y * w + x]!;
  } else {
    for (let y = band.a; y < band.b; y++)
      for (let x = 0; x < w; x++) profile[x]! += mask[y * w + x]!;
  }
  const runs = bands(profile, 0, Math.max(2, (band.b - band.a) * 1.5));
  if (runs.length === 0) return null;
  // The heaviest run is the line body.
  const body = runs.reduce((best, r) => (r.mass > best.mass ? r : best));
  return { a: body.a, b: body.b, profile };
}

/** Cut points for a line longer than MAX_RATIO widths: each ideal cut
    moves to the emptiest spot within one width — the middle of a blank run
    between glyphs when there is one, so no crop carries a sliver of its
    neighbour. */
export function cutPoints(a: number, b: number, width: number, profile: Float64Array): number[] {
  const n = Math.ceil((b - a) / (width * MAX_RATIO));
  const cuts: number[] = [];
  let prev = a;
  for (let k = 1; k < n; k++) {
    const ideal = Math.round(a + ((b - a) * k) / n);
    const lo = Math.max(prev + 1, ideal - width);
    const hi = Math.min(b - 1, ideal + width);
    let best = ideal;
    for (let i = lo; i <= hi; i++) {
      const better =
        profile[i]! < profile[best]! ||
        (profile[i]! === profile[best]! && Math.abs(i - ideal) < Math.abs(best - ideal));
      if (better) best = i;
    }
    // Centre the cut in its blank run.
    let r0 = best, r1 = best;
    while (r0 > lo && profile[r0 - 1]! === profile[best]!) r0--;
    while (r1 < hi && profile[r1 + 1]! === profile[best]!) r1++;
    const cut = Math.round((r0 + r1) / 2);
    cuts.push(cut);
    prev = cut;
  }
  return cuts;
}

/** PIL "L" luma (ITU-R 601-2, PIL's fixed-point form) of an RGBA raster —
    the grayscale manga-ocr itself reads. */
export function grayFromRgba(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let p = 0; p < data.length; p++) {
    data[p] =
      (rgba[p * 4]! * 19595 + rgba[p * 4 + 1]! * 38470 + rgba[p * 4 + 2]! * 7471 + 0x8000) >> 16;
  }
  return { data, width, height };
}
