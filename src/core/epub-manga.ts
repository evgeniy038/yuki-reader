import { packedImagePaths } from "./epub-utils";
import type { EpubResource, ParsedEpub } from "./reading";

// Comic EPUBs (fixed-layout scans from stores, calibre conversions of cbz)
// are EPUB only on the outside: every spine document is a page wrapper — one
// <img> or <svg><image> and not a single character of text. Reflowing them
// as a book shows nothing readable, so the importer hands them to the manga
// reader instead. The test is the content itself, not the OPF flags
// (rendition:layout, book-type) — converters drop those freely.

/** Visible text of a chapter: head, scripts, styles, comments and tags gone,
    common whitespace entities folded. */
function visibleText(html: string): string {
  return html
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:nbsp|#160|#x0*a0|#12288|#x0*3000);/gi, "")
    .replace(/[\s　​﻿]+/g, "");
}

/** Page images in spine order when the EPUB is an image-only comic (no
    chapter carries text, at least one carries an image); null otherwise. */
export function mangaPagesOf(parsed: ParsedEpub): EpubResource[] | null {
  if (parsed.chapters.length === 0) return null;
  const byPath = new Map(parsed.resources.map((res) => [res.path, res]));
  const pages: EpubResource[] = [];
  for (const chapter of parsed.chapters) {
    if (visibleText(chapter.html) !== "") return null;
    for (const path of packedImagePaths(chapter.html)) {
      const resource = byPath.get(path);
      if (resource?.mime.startsWith("image/")) pages.push(resource);
    }
  }
  return pages.length > 0 ? pages : null;
}
