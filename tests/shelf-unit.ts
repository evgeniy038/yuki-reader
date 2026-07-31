// Node unit test for the shelf domain module (src/core/library.ts):
// sorting, language grouping, reading state, language detection.
// Pure functions — no browser needed. Run: pnpm tsx tests/shelf-unit.ts

import { strict as assert } from "node:assert";
import {
  detectLanguage,
  groupByLanguage,
  readingStateOf,
  sortBooks,
  type Book,
} from "../src/core/library.ts";

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
  assert.deepEqual(groups[0]!.books, [ja]);
  assert.deepEqual(groups[2]!.books, [none]);
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

console.log("SHELF UNIT: PASS");
