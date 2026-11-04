import type { BookKey } from "./model";

// A book's identity across devices, from its CONTENT only. The shelf's
// contentHash can't serve: it folds the file name in (an EPUB without a
// title, every PDF scan, every manga volume), so the same volume imported
// as "Oshinoko_1" on one device and "推しの子 第01巻" on another never
// matched (probed on the owner's files: same 218 pages, two hashes). These
// keys ignore names and packaging; the version prefix lets the algorithm
// change later without collisions.
//   e1: EPUB — the chapters' text with markup, ruby readings and whitespace
//       removed (robust to parser markup tweaks; same text = same character
//       positions, which is what a 0..1 position means). Image-only books
//       fall back to their resource bytes.
//   p1: PDF — the file bytes themselves (stored as-is).
//   m1: manga — page count plus, per page, its size and a hash of its first
//       64 KiB: name-free, cheap (no full read of a 300 MB volume), and the
//       same for a zip, a folder or an image-only EPUB of the same scans.

export const MANGA_HEAD_BYTES = 64 * 1024;

const encoder = new TextEncoder();

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Visible text of one chapter: no tags, no <rt>/<rp> readings, no
    whitespace, entities left as opaque tokens, NFC. */
export function chapterText(html: string): string {
  return html
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, "")
    .normalize("NFC");
}

export async function epubKey(
  chapters: readonly { html: string }[],
  resources: readonly { bytes: Uint8Array }[] = [],
): Promise<BookKey> {
  const text = chapters.map((chapter) => chapterText(chapter.html)).join("\u0000");
  if (text.replace(/\u0000/g, "") !== "") return `e1:${hex(await sha256(text))}`;
  const parts: string[] = [];
  for (const resource of resources) parts.push(hex(await sha256(resource.bytes)));
  return `e1:${hex(await sha256(`res\n${parts.join("\n")}`))}`;
}

export async function pdfKey(bytes: Uint8Array): Promise<BookKey> {
  return `p1:${hex(await sha256(bytes))}`;
}

/** One page as the key sees it: full size + the first MANGA_HEAD_BYTES. */
export interface PageSample {
  size: number;
  head: Uint8Array;
}

export async function mangaKey(pages: readonly PageSample[]): Promise<BookKey> {
  const lines = [String(pages.length)];
  for (const page of pages) lines.push(`${page.size}:${hex(await sha256(page.head))}`);
  return `m1:${hex(await sha256(lines.join("\n")))}`;
}

/** Sample a stored page blob for mangaKey. */
export async function samplePage(blob: Blob): Promise<PageSample> {
  const head = new Uint8Array(await blob.slice(0, MANGA_HEAD_BYTES).arrayBuffer());
  return { size: blob.size, head };
}
