// Node unit test for the OCR line splitter (src/core/ocr/lines.ts) on
// synthetic glyph rasters: the split policy (only when the whole-block crop
// starves the glyphs), orientation by line spacing (columns in wide
// bubbles, rows only in wide blocks), column order, ruby folding, touching
// columns, long-line chunking at glyph gaps, outline arcs and art bands
// dropped, coverage. `splitBelowPx: Infinity` tests the mechanics alone.
// Run: pnpm tsx tests/ocr-lines-unit.ts

import { strict as assert } from "node:assert";
import { grayFromRgba, splitLines, type Gray } from "../src/core/ocr/lines.ts";

/** White canvas; `glyph` paints a hollow-ish dark square (a stroke ring
    plus a bar) so ink covers well under half of its cell, like real type. */
function canvas(width: number, height: number) {
  const data = new Uint8Array(width * height).fill(255);
  const g: Gray = { data, width, height };
  const fill = (x1: number, y1: number, x2: number, y2: number) => {
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) data[y * width + x] = 0;
  };
  const glyph = (x: number, y: number, size: number) => {
    const t = Math.max(1, Math.round(size / 12));
    fill(x, y, x + size, y + t);
    fill(x, y + size - t, x + size, y + size);
    fill(x, y, x + t, y + size);
    fill(x + size - t, y, x + size, y + size);
    fill(x + (size >> 1) - (t >> 1), y, x + (size >> 1) + t, y + size);
  };
  return { g, fill, glyph };
}

/** A vertical column of `n` glyphs of `size` with `gap` between them. */
function column(c: ReturnType<typeof canvas>, x: number, y: number, n: number, size: number, gap = 4) {
  for (let i = 0; i < n; i++) c.glyph(x, y + i * (size + gap), size);
}

// --- policy: split only when the whole-block crop starves the glyphs ----------
{
  // Three short columns of 36px glyphs: squeezed whole into 224², a glyph
  // keeps ~36px — manga-ocr reads that better whole.
  const roomy = canvas(200, 220);
  for (let i = 0; i < 3; i++) column(roomy, 20 + i * 62, 10, 5, 36);
  assert.equal(splitLines(roomy.g, true), null, "a roomy block keeps its whole crop");
  // Six columns of fourteen: the whole crop leaves a glyph ~13px.
  const dense = canvas(6 * 62 + 20, 14 * 40 + 20);
  for (let i = 0; i < 6; i++) column(dense, 20 + i * 62, 10, 14, 36);
  const split = splitLines(dense.g, true);
  assert.ok(split, "a dense block splits");
  assert.equal(split.lines.length, 6);
  // A grid-aligned vertical block must never be read as rows across its
  // columns, whatever its row gaps look like.
  assert.ok(split.lines.every((line) => line[0]!.y2 - line[0]!.y1 > line[0]!.x2 - line[0]!.x1));
}

// --- a wide bubble of short columns is columns, whatever its aspect -------------
{
  // Five columns of four glyphs: wider than tall, so the aspect says
  // "horizontal" — but glyphs sit 4px apart and columns 22px apart.
  const c = canvas(5 * 58 + 20, 4 * 40 + 20);
  for (let i = 0; i < 5; i++) column(c, 10 + i * 58, 10, 4, 36);
  const split = splitLines(c.g, false, { splitBelowPx: Infinity });
  assert.ok(split, "wide columnar block splits");
  assert.equal(split.lines.length, 5, "into its five columns, not four rows");
  assert.ok(split.lines[0]![0]!.x1 > split.lines[4]![0]!.x1, "right→left");
}

// --- a bubble-outline arc clipped by the box is not a line --------------------
{
  const c = canvas(5 * 58 + 40, 4 * 40 + 20);
  for (let i = 0; i < 4; i++) column(c, 10 + i * 58, 10, 4, 36);
  // A thin diagonal stroke in the top-right corner, one glyph tall.
  for (let k = 0; k < 34; k++) c.fill(250 + k, 10 + k, 253 + k, 13 + k);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  assert.equal(split.lines.length, 4, "the arc is dropped, the four columns stay");
  assert.ok(split.lines[0]![0]!.x2 < 250, "no crop starts on the arc");
}

// --- a tall block is never read as rows ---------------------------------------
{
  // Two tight columns of loosely spaced glyphs: across the columns, the
  // glyph rows look like "lines" — reading them would interleave columns.
  const c = canvas(2 * 40 + 26, 6 * 48 + 20);
  for (let i = 0; i < 2; i++) column(c, 10 + i * 42, 10, 6, 36, 12);
  assert.equal(splitLines(c.g, true, { splitBelowPx: Infinity }), null, "tall 2-column block reads whole, not as rows");
}

// --- a paragraph of horizontal rows splits into its rows ---------------------
{
  // Four rows of ten glyphs: glyphs 4px apart, rows 16px apart.
  const c = canvas(10 * 40 + 20, 4 * 52 + 20);
  for (let r = 0; r < 4; r++) for (let i = 0; i < 10; i++) c.glyph(10 + i * 40, 10 + r * 52, 36);
  const split = splitLines(c.g, false, { splitBelowPx: Infinity });
  assert.ok(split, "multi-row paragraph splits");
  assert.equal(split.vertical, false);
  assert.equal(split.lines.length, 4, "into its four rows, top to bottom");
  assert.ok(split.lines[0]![0]!.y1 < split.lines[3]![0]!.y1);
}

// --- three vertical columns, read right → left ---------------------------------
{
  const c = canvas(200, 220);
  column(c, 20, 10, 5, 36);
  column(c, 82, 10, 4, 36);
  column(c, 144, 10, 3, 36);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split, "multi-column block splits");
  assert.equal(split.lines.length, 3);
  // Reading order: rightmost column first.
  const xs = split.lines.map((line) => line[0]!.x1);
  assert.ok(xs[0]! > xs[1]! && xs[1]! > xs[2]!, `right→left order, got ${xs}`);
  // Each line hugs its column: the 3-glyph column is the shortest.
  const first = split.lines[0]![0]!;
  assert.ok(first.y2 - first.y1 < 3 * 40 + 20, "line extent follows its own ink");
  // Neighbouring crops never overlap (no sliver of the next column).
  for (let i = 1; i < split.lines.length; i++) {
    assert.ok(split.lines[i]![0]!.x2 <= split.lines[i - 1]![0]!.x1, "crops do not overlap");
  }
}

// --- ruby is left out of its column's crop (or folded in, on request) ---------
{
  const c = canvas(150, 200);
  column(c, 20, 10, 4, 36);
  column(c, 90, 10, 4, 36);
  // Small kana to the RIGHT of the left column (ruby side in vertical text).
  column(c, 60, 14, 3, 14, 6);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  assert.equal(split.lines.length, 2, "ruby never becomes a line of its own");
  const left = split.lines[1]![0]!;
  // Read alone, a column would hand its furigana over as text.
  assert.ok(left.x2 <= 60, `the left column's crop keeps clear of its ruby (x2 ${left.x2})`);
  const folded = splitLines(c.g, true, { splitBelowPx: Infinity, ruby: "fold" });
  assert.ok(folded && folded.lines[1]![0]!.x2 >= 74, "fold keeps the ruby inside the crop");
}

// --- ruby too faint to form a band still stays out of the crop ---------------
{
  // Long columns; two small kana beside the top of the left column — too
  // little ink over the column's length to count as a band of its own.
  const c = canvas(4 * 62 + 40, 12 * 40 + 20);
  for (let i = 0; i < 4; i++) column(c, 20 + i * 62, 10, 12, 36);
  column(c, 59, 12, 2, 12, 4);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  const left = split.lines[split.lines.length - 1]![0]!;
  assert.ok(left.x2 <= 59, `the crop stops before the faint ruby (x2 ${left.x2})`);
}

// --- edge bands: ruby beside the first column goes, a short last column stays ---
{
  // Five columns of eight glyphs, read right → left. Right of the first
  // column: three small ruby kana plus a thin bubble-outline stroke — wide
  // enough to pass for a column, but light.
  const c = canvas(6 * 58 + 60, 8 * 40 + 20);
  for (let i = 0; i < 5; i++) column(c, 60 + i * 58, 10, 8, 36);
  column(c, 60 + 4 * 58 + 42, 12, 3, 12, 4);
  c.fill(60 + 4 * 58 + 58, 40, 60 + 4 * 58 + 60, 200);
  // A real closing line, left of the rest: one full-size glyph.
  c.glyph(2, 10, 36);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  assert.equal(split.lines.length, 6, "five columns plus the one-glyph closing line");
  assert.ok(split.lines[0]![0]!.x2 <= 60 + 4 * 58 + 42, "the first column's crop stops before its ruby");
  assert.ok(split.lines[5]![0]!.x1 <= 2, "the closing line is read");
}

// --- a short opening line of full-size glyphs is text, not an edge band ------
{
  // でも / そのハマりっぷりは / なんか生々しい: the bubble opens with a
  // two-glyph column of narrow kana — light, short and 0.8 of a typical
  // line's width (as measured on the real page), ruby runs ~half.
  const c = canvas(3 * 58 + 40, 9 * 40 + 20);
  column(c, 20 + 2 * 58 + 4, 10, 2, 29, 11);
  column(c, 20 + 58, 10, 9, 36);
  column(c, 20, 10, 7, 36);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  assert.equal(split.lines.length, 3, "the two-glyph opening column stays a line");
  assert.ok(split.lines[0]![0]!.x1 >= 20 + 58 + 36, "and is read first");
}

// --- a horizontal title with ruby above is not a row of columns ----------------
{
  // Ten glyphs in a row, each with a small ruby glyph above: every
  // glyph+ruby pair looks like a short "column" — read as columns, the
  // title would come out backwards.
  const c = canvas(10 * 46 + 20, 80);
  for (let i = 0; i < 10; i++) {
    c.glyph(10 + i * 46 + 10, 4, 16);
    c.glyph(10 + i * 46, 26, 36);
  }
  const split = splitLines(c.g, false, { splitBelowPx: Infinity });
  assert.ok(!split || !split.vertical, "a wide title is never read as columns");
}

// --- one horizontal line of glyphs is NOT a block of columns -------------------
{
  // 6 glyphs in a row: the column profile shows six "bands", but they are
  // glyph cells (square), not lines — the block is one short line.
  const c = canvas(260, 50);
  for (let i = 0; i < 6; i++) c.glyph(8 + i * 40, 7, 36);
  assert.equal(splitLines(c.g, false), null, "short single line keeps the whole-block crop");
}

// --- a long single line is cut into chunks at glyph gaps -----------------------
{
  // 40 glyphs in one row: 40 widths long, past the chunk limit.
  const size = 20, gap = 6;
  const c = canvas(40 * (size + gap) + 10, 30);
  for (let i = 0; i < 40; i++) c.glyph(5 + i * (size + gap), 5, size);
  const split = splitLines(c.g, false);
  assert.ok(split, "long line is chunked");
  assert.equal(split.lines.length, 1);
  const chunks = split.lines[0]!;
  assert.ok(chunks.length >= 2, "several chunks");
  // Every internal cut lands in a blank gap between glyphs, not inside one.
  for (let k = 1; k < chunks.length; k++) {
    const cut = chunks[k]!.x1;
    const offset = (cut - 5) % (size + gap);
    assert.ok(offset >= size - 1, `cut ${cut} falls in a gap (offset ${offset})`);
    assert.equal(chunks[k - 1]!.x2, cut, "chunks meet at the cut, no overlap");
  }
}

// --- a solid wedge beside the text is art, not a line ---------------------------
{
  const c = canvas(150, 200);
  column(c, 20, 10, 4, 36);
  column(c, 80, 10, 4, 36);
  c.fill(130, 0, 150, 120); // a black bubble tail / speed-line wedge
  // The wedge never becomes a line or rides inside one: with that much ink
  // outside every line, the block reads whole.
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(!split || split.lines.every((line) => line[0]!.x2 <= 130), "no crop on the wedge");
  // A far-off wedge (not beside a column) is plain art: dropped as a band,
  // the columns still split.
  const far = canvas(220, 200);
  column(far, 20, 10, 4, 36);
  column(far, 80, 10, 4, 36);
  far.fill(196, 0, 216, 30);
  const apart = splitLines(far.g, true, { splitBelowPx: Infinity });
  assert.ok(!apart || apart.lines.every((line) => line[0]!.x2 <= 196), "no crop on far art");
}

// --- light text on a dark ground still splits ---------------------------------
{
  const c = canvas(150, 200);
  column(c, 20, 10, 4, 36);
  column(c, 90, 10, 4, 36);
  for (let i = 0; i < c.g.data.length; i++) c.g.data[i] = 255 - c.g.data[i]!;
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split, "inverted polarity splits too");
  assert.equal(split.lines.length, 2);
}

// --- columns set so tight their gap vanishes are still two lines -------------
{
  const c = canvas(300, 220);
  // Four columns, the middle two touching (no blank column between them).
  column(c, 20, 10, 5, 36);
  column(c, 82, 10, 5, 36);
  column(c, 118, 10, 5, 36);
  column(c, 190, 10, 5, 36);
  const split = splitLines(c.g, true, { splitBelowPx: Infinity });
  assert.ok(split);
  assert.equal(split.lines.length, 4, "the merged band splits at its seam");
}

// --- crops that would miss ink send the block back whole ------------------------
{
  const c = canvas(300, 320);
  for (let i = 0; i < 4; i++) column(c, 20 + i * 62, 10, 4, 36);
  // A row of glyphs far below the columns (more than 1.5 line widths of
  // blank between): no line body reaches them.
  for (let i = 0; i < 4; i++) c.glyph(20 + i * 62, 270, 36);
  assert.equal(splitLines(c.g, true, { splitBelowPx: Infinity }), null, "uncovered ink → whole-block read");
}

// --- luma matches PIL's "L" ---------------------------------------------------
{
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 10, 20, 30, 255]);
  const g = grayFromRgba(rgba, 4, 1);
  // PIL: L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
  assert.deepEqual([...g.data], [76, 150, 29, 18]);
}

console.log("ocr-lines-unit: ok");
