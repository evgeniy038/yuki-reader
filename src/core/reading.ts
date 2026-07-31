export interface EpubMetadata {
  title: string;
  creator?: string;
  language?: string;
}

export interface Chapter {
  id: string;
  title?: string;
  /** Raw spine-item XHTML. Sanitizing + rendering happens in the UI layer. */
  html: string;
}

export interface TocEntry {
  label: string;
  /** Spine chapter id — the section's data-chapter value in the reader. */
  chapterId: string;
}

export interface EpubResource {
  /** Zip-root-relative path, used as the blob-map key and dummy-URL token. */
  path: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ParsedEpub {
  metadata: EpubMetadata;
  chapters: Chapter[];
  /** Table of contents from the NCX / nav document; empty when the book
      carries none — the caller falls back to deriveToc. */
  toc: TocEntry[];
  cover?: { mime: string; bytes: Uint8Array };
  /** Packed images (and other binary resources) for blob object-URL creation. */
  resources: EpubResource[];
  /** Concatenated book stylesheets (raw; scoping happens at render time). */
  bookCss: string;
}

// Fallback table of contents derived from the chapters themselves — for books
// without an NCX/nav and for records imported before TOC parsing existed.
// Label: the chapter <title>, else the first plain-text chars of the chapter;
// textless chapters (covers, image pages) drop out.
export function deriveToc(chapters: Chapter[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const chapter of chapters) {
    let label = chapter.title?.trim() ?? "";
    if (label === "") {
      const plain = chapter.html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      label = plain.slice(0, 24);
    }
    if (label !== "") out.push({ label, chapterId: chapter.id });
  }
  return out;
}
