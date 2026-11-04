// Node unit test for the book storage split (DB v8): a v7 library — whole
// books inside the shelf records — migrates into lean shelf records plus a
// content store, nothing lost; the lean loader reads no content, whole-book
// readers (backup) still get every byte, and a progress save never touches
// the content. Run: pnpm tsx tests/storage-unit.ts
import "fake-indexeddb/auto";
import { strict as assert } from "node:assert";
import { openDB } from "idb";
import {
  deleteBook,
  loadAllBooks,
  loadBookContent,
  loadShelfBooks,
  putBook,
  saveProgress,
  type BookRecord,
} from "../src/core/storage.ts";

const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49]);
const legacy = [
  {
    id: "novel",
    title: "キッチン",
    progress: 0.25,
    addedAt: 2000,
    contentHash: "h1",
    chapters: [{ id: "c1", title: "一", html: "<p>台所が好きだ。</p>" }],
    toc: [{ label: "一", chapterId: "c1" }],
    resources: [{ path: "OEBPS/a.jpg", mime: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }],
    bookCss: "p { margin: 0 }",
    // format and language left out: the pre-v8 shelf backfilled them on
    // every load; the migration settles them once.
  },
  {
    id: "paper",
    title: "Paper",
    progress: 0,
    addedAt: 1000,
    format: "pdf",
    language: "en",
    pageCount: 2,
    chapters: [{ id: "sample", html: "<p>Hello world</p>" }],
    pdfBytes,
  },
];

// A v7 database exactly as the app left it: whole books in `books`.
{
  const v7 = await openDB("yuki", 7, {
    upgrade(db) {
      db.createObjectStore("books", { keyPath: "id" });
      db.createObjectStore("stats", { keyPath: "date" });
      db.createObjectStore("manga", { keyPath: "id" });
      db.createObjectStore("mangaPages");
      db.createObjectStore("mangaOcr");
      db.createObjectStore("ocrModels", { keyPath: "url" });
      db.createObjectStore("dictionaries", { keyPath: "id" });
      db.createObjectStore("dictionaryEntries", { keyPath: "key" }).createIndex(
        "byDictionaryTerm",
        ["dictionaryId", "termKey"],
      );
      db.createObjectStore("dictionaryArchives", { keyPath: "id" });
    },
  });
  for (const record of legacy) await v7.put("books", record);
  v7.close();
}

// Migration: lean shelf records, content moved over intact.
{
  const shelf = await loadShelfBooks();
  assert.deepEqual(
    shelf.map((book) => book.id),
    ["novel", "paper"],
    "newest first",
  );
  for (const book of shelf) {
    assert.ok(!("chapters" in book) && !("resources" in book) && !("pdfBytes" in book));
  }
  const novel = shelf[0]!;
  assert.equal(novel.format, "epub", "format backfilled from the content");
  assert.equal(novel.language, "ja", "language backfilled from the text");
  assert.equal(novel.contentHash, "h1");
  assert.equal(novel.progress, 0.25);

  const content = await loadBookContent("novel");
  assert.equal(content?.chapters[0]?.html, "<p>台所が好きだ。</p>");
  assert.deepEqual(content?.toc, legacy[0]!.toc);
  assert.deepEqual([...(content?.resources?.[0]?.bytes ?? [])], [1, 2, 3]);
  assert.equal(content?.bookCss, "p { margin: 0 }");
  assert.deepEqual([...((await loadBookContent("paper"))?.pdfBytes ?? [])], [...pdfBytes]);

  // The raw stores: nothing heavy left in the shelf store.
  const db = await openDB("yuki", 8);
  const raw = await db.get("books", "paper");
  assert.ok(raw && !("pdfBytes" in raw) && !("chapters" in raw));
  db.close();
  console.log("  ✓ v7 → v8: shelf records lean, content moved, backfills persisted");
}

// Whole-book readers (backup export) still see every byte.
{
  const all = await loadAllBooks();
  const paper = all.find((book) => book.id === "paper");
  assert.deepEqual([...(paper?.pdfBytes ?? [])], [...pdfBytes]);
  assert.equal(all.find((book) => book.id === "novel")?.chapters.length, 1);
  console.log("  ✓ loadAllBooks joins shelf records and content");
}

// putBook splits; a progress save rewrites the shelf record only.
{
  const record: BookRecord = {
    id: "fresh",
    title: "Fresh",
    progress: 0,
    addedAt: 3000,
    format: "epub",
    chapters: [{ id: "c1", html: "<p>new</p>" }],
    bookCss: "",
  };
  await putBook(record);
  await saveProgress("fresh", 0.5);
  const shelf = await loadShelfBooks();
  assert.equal(shelf[0]?.id, "fresh");
  assert.equal(shelf[0]?.progress, 0.5);
  assert.ok(!("chapters" in shelf[0]!));
  assert.equal((await loadBookContent("fresh"))?.chapters[0]?.html, "<p>new</p>");
  console.log("  ✓ putBook splits, progress saves keep the content");
}

// Delete drops both halves.
{
  await deleteBook("fresh");
  assert.equal((await loadShelfBooks()).some((book) => book.id === "fresh"), false);
  assert.equal(await loadBookContent("fresh"), undefined);
  console.log("  ✓ deleteBook removes the record and its content");
}

console.log("storage-unit: all checks passed");
