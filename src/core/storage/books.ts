import type { Book } from "../library";
import type { Chapter, EpubResource, TocEntry } from "../reading";
import { BOOKS, open } from "./db";
import { deleteManga } from "./manga";

export interface BookRecord extends Book {
  chapters: Chapter[];
  /** Table of contents (EPUB): NCX/nav entries mapped to spine chapter ids. */
  toc?: TocEntry[];
  resources?: EpubResource[];
  bookCss?: string;
  /** Raw PDF bytes — the PDF reader renders pages straight from them. */
  pdfBytes?: Uint8Array;
}

export async function loadAllBooks(): Promise<BookRecord[]> {
  const db = await open();
  const records = await db.getAll(BOOKS);
  return records.sort((a, b) => b.addedAt - a.addedAt);
}

export async function putBook(record: BookRecord): Promise<void> {
  const db = await open();
  await db.put(BOOKS, record);
}

export async function saveProgress(id: string, progress: number): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (record) {
    record.progress = progress;
    record.lastReadAt = Date.now();
    await db.put(BOOKS, record);
  }
}

export async function restoreBookProgress(
  id: string,
  progress: number,
  lastReadAt?: number,
): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (!record) return;
  record.progress = Math.min(1, Math.max(0, progress));
  record.lastReadAt = lastReadAt;
  await db.put(BOOKS, record);
}

export async function deleteBook(id: string): Promise<void> {
  const db = await open();
  await db.delete(BOOKS, id);
  await deleteManga(id);
}

export async function updateBookMeta(
  id: string,
  patch: Partial<
    Pick<
      BookRecord,
      | "title"
      | "author"
      | "cover"
      | "contentHash"
      | "lastReadAt"
      | "format"
      | "series"
      | "volumeIndex"
      | "favorite"
    >
  >,
): Promise<void> {
  const db = await open();
  const record = await db.get(BOOKS, id);
  if (record) {
    Object.assign(record, patch);
    await db.put(BOOKS, record);
  }
}
