// Node unit test for the shelf domain module (src/core/library.ts):
// sorting, language grouping, reading state, language detection.
// Pure functions — no browser needed. Run: pnpm tsx tests/shelf-unit.ts

import { strict as assert } from "node:assert";
import {
  buildShelfItems,
  detectLanguage,
  groupByLanguage,
  readingStateOf,
  sortBooks,
  type Book,
} from "../src/core/library.ts";
import { naturalCompare, splitSeriesVolume } from "../src/core/mokuro.ts";

let id = 0;
function book(patch: Partial<Book>): Book {
  id += 1;
  return {
    id: String(id),
    title: `book-${id}`,
    progress: 0,
    addedAt: 1_000 + id,
    ...patch,
  };
}

// --- sort: recent = max(lastReadAt, addedAt) desc -------------------------
{
  const a = book({ title: "A", addedAt: 100, lastReadAt: 500 });
  const b = book({ title: "B", addedAt: 400 }); // fresh unread import
  const c = book({ title: "C", addedAt: 300, lastReadAt: 350 });
  assert.deepEqual(
    sortBooks([a, b, c], "recent").map((x) => x.title),
    ["A", "B", "C"],
    "recent: read-at beats added-at, unread falls back to added-at",
  );
}

// --- sort: title / author / added / progress -------------------------------
{
  const a = book({ title: "雪国", author: "川端康成", progress: 0.4, addedAt: 100 });
  const b = book({ title: "厨房", author: "吉本ばなな", progress: 0.9, addedAt: 200 });
  const c = book({ title: "GOTH", author: "乙一", progress: 0.1, addedAt: 300 });
  assert.deepEqual(
    sortBooks([a, b, c], "added").map((x) => x.title),
    ["GOTH", "厨房", "雪国"],
    "added: newest first",
  );
  assert.deepEqual(
    sortBooks([a, b, c], "progress").map((x) => x.title),
    ["厨房", "雪国", "GOTH"],
    "progress: most-read first",
  );
  const byTitle = sortBooks([a, b, c], "title").map((x) => x.title);
  assert.deepEqual(
    [...byTitle].sort((x, y) => x.localeCompare(y, "ja")),
    byTitle,
    "title: ascending, input order not mutated",
  );
  const byAuthor = sortBooks([a, b, c], "author").map((x) => x.author);
  assert.deepEqual(
    [...byAuthor].sort((x, y) => x!.localeCompare(y!, "ja")),
    byAuthor,
    "author: ascending",
  );
}

// --- grouping: ja → en → other, empties dropped ---------------------------
{
  const ja = book({ title: "和", language: "ja" });
  const en = book({ title: "EN", language: "en" });
  const none = book({ title: "??" });
  const groups = groupByLanguage([none, en, ja]);
  assert.deepEqual(
    groups.map((g) => g.id),
    ["ja", "en", "other"],
    "group order",
  );
  assert.deepEqual(groups[0]!.items, [ja]);
  assert.deepEqual(groups[2]!.items, [none]);
  assert.deepEqual(
    groupByLanguage([ja]).map((g) => g.id),
    ["ja"],
    "empty groups are omitted (no headers on a single-language shelf)",
  );
}

// --- reading state ----------------------------------------------------------
{
  assert.equal(readingStateOf(book({ progress: 0 })), "new");
  assert.equal(readingStateOf(book({ progress: 0.42 })), "reading");
  assert.equal(readingStateOf(book({ progress: 1 })), "finished");
  assert.equal(readingStateOf(book({ progress: 0.996 })), "finished");
}

// --- language detection ------------------------------------------------------
{
  assert.equal(
    detectLanguage("<p>吾輩は猫である。名前はまだ無い。</p>"),
    "ja",
  );
  assert.equal(
    detectLanguage("<p>The owner stopped moving and looked at me.</p>"),
    "en",
  );
  assert.equal(detectLanguage("<p>…　　</p>"), undefined);
}

// --- manga: series/volume derivation from real-world file names -------------
{
  assert.deepEqual(
    splitSeriesVolume("[赤坂アカ] かぐや様は告らせたい～天才たちの恋愛頭脳戦～ 第01巻"),
    { series: "かぐや様は告らせたい～天才たちの恋愛頭脳戦～", volumeIndex: 1 },
    "author bracket + 第N巻",
  );
  assert.deepEqual(
    splitSeriesVolume("[吾峠呼世晴] 鬼滅の刃 第01巻-20260731T164242Z-1-001"),
    { series: "鬼滅の刃", volumeIndex: 1 },
    "drive-export suffix is junk",
  );
  assert.deepEqual(splitSeriesVolume("Oshinoko_3"), {
    series: "Oshinoko",
    volumeIndex: 3,
  });
  assert.deepEqual(splitSeriesVolume("Oshinoko_v05"), {
    series: "Oshinoko",
    volumeIndex: 5,
  });
  assert.deepEqual(splitSeriesVolume("oshinoko_4"), {
    series: "oshinoko",
    volumeIndex: 4,
  });
  assert.deepEqual(splitSeriesVolume("余命10年"), { series: "余命10年" },
    "a number that is not a volume marker stays in the name");
  assert.ok(naturalCompare("2.jpg", "10.jpg") < 0, "natural: 2 before 10");
  assert.ok(naturalCompare("第２巻", "第10巻") < 0, "natural: fullwidth digits fold");
}

// --- manga: volumes collapse into one series tile ---------------------------
{
  const v1 = book({ format: "manga", series: "Oshinoko", volumeIndex: 1, title: "Oshinoko 1", progress: 1 });
  const v3 = book({ format: "manga", series: "Oshinoko", volumeIndex: 3, title: "Oshinoko 3", progress: 0 });
  const epub = book({ format: "epub", title: "厨房" });
  const items = buildShelfItems([v1, epub, v3]);
  assert.equal(items.length, 2, "two volumes → one series item + one book");
  const series = items[0];
  assert.equal(series.kind, "series");
  if (series.kind === "series") {
    assert.equal(series.series, "Oshinoko");
    assert.equal(series.volumeCount, 2);
    assert.equal(series.progress, 0.5, "progress is the mean of the volumes");
  }
  // Case/width variants of the series name still merge.
  const a = book({ format: "manga", series: "Oshinoko", volumeIndex: 2 });
  const b = book({ format: "manga", series: "oshinoko", volumeIndex: 4 });
  assert.equal(
    buildShelfItems([a, b]).filter((item) => item.kind === "series").length,
    1,
    "series matching is case-insensitive",
  );
}

console.log("SHELF UNIT: PASS");
