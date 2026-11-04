import { blobToDataUrl } from "./data-url";
import { epubEntryLookup, parseEpubFiles } from "./epub";
import { mangaPagesOf } from "./epub-manga";
import { mangaVolumeFromEpub, type ImportedMangaVolume } from "./import-manga";
import { detectLanguage, type BookFormat, type Language } from "./library";
import { unzipSync } from "fflate";
import {
  deriveToc,
  type Chapter,
  type EpubResource,
  type ParsedEpub,
  type TocEntry,
} from "./reading";
import { byOffset, openZip } from "./zip-entries";

// Book-file import pipeline: raw file → everything the shelf and the readers
// need. One place owns the EPUB/PDF split and every fallback (title from the
// filename, language sniffed from the text, TOC derived when the book has no
// NCX/nav), so App's `openFile` is just: import → dedupe → store → open.
// Image-only comic EPUBs come back as a manga volume instead of a book.

interface ImportedFile {
  format: BookFormat;
  /** Final display title (metadata, or the file name when metadata is empty). */
  title: string;
  author?: string;
  language?: Language;
  chapters: Chapter[];
  /** EPUB only: real NCX/nav when present, chapter-derived otherwise. */
  toc?: TocEntry[];
  cover?: string;
  resources: EpubResource[];
  bookCss: string;
  /** Raw PDF bytes — the PDF reader renders pages straight from them. */
  pdfBytes?: Uint8Array;
  /** Total pages (PDF only; EPUB length lives in chapters). */
  pageCount?: number;
}

export type ImportedBookFile =
  | ({ kind: "book" } & ImportedFile)
  | { kind: "manga"; volume: ImportedMangaVolume };

function toLanguage(code: string | undefined): Language | undefined {
  const c = (code ?? "").toLowerCase();
  if (c.startsWith("ja")) return "ja";
  if (c.startsWith("en")) return "en";
  return undefined;
}

/** EPUBs up to this size are read whole (novels); bigger ones lazily. */
const WHOLE_READ_MAX = 32 * 1024 * 1024;

/** Raster images inside an EPUB — read only once the book's kind is known. */
const RASTER = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;

export async function importBookFile(file: File): Promise<ImportedBookFile> {
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    // PDF: pages are rendered straight from the stored bytes at read time.
    // Import keeps only a text sample (language + dup hash), the page count,
    // and a cover render — no reflowed text, so ugly PDFs (scans, formulas,
    // layouts) survive untouched. pdf.js (~350 kB min) loads on demand here:
    // importing an EPUB never pays for it.
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { importPdf } = await import("./pdf");
    const parsed = await importPdf(bytes);
    return finalize(file, {
      format: "pdf",
      title: parsed.metadata.title,
      chapters: parsed.sampleHtml ? [{ id: "sample", html: parsed.sampleHtml }] : [],
      cover: parsed.cover,
      resources: [],
      bookCss: "",
      pdfBytes: bytes,
      pageCount: parsed.numPages,
    });
  }

  // EPUB. A small file is unpacked whole — one read beats a hundred small
  // ones. A big one (an image-only comic is 100-250MB) is read lazily
  // (zip-entries): text entries first — XHTML, OPF, CSS, small — with every
  // raster image stubbed empty. That is enough to tell a comic from a book:
  // a comic's pages then come straight from the archive (slices of the
  // file, or inflated one by one) and never sit in memory together; a book
  // reads its images and parses for real.
  if (file.size <= WHOLE_READ_MAX) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return finishEpub(file, parseEpubFiles(unzipSync(bytes)));
  }
  const zip = await openZip(file);
  const files: Record<string, Uint8Array> = {};
  const images: string[] = [];
  for (const [name, entry] of zip.entries) {
    if (RASTER.test(name)) {
      files[name] = new Uint8Array(0);
      images.push(name);
    } else {
      files[name] = await zip.bytes(entry);
    }
  }
  const outline = parseEpubFiles(files);
  if (mangaPagesOf(outline)) {
    // Every raster read once, in archive order; pages pick theirs by path.
    const lookup = epubEntryLookup([...zip.entries.keys()]);
    const blobs = new Map<string, Blob>();
    for (const name of byOffset(zip.entries, images)) {
      blobs.set(name, await zip.blob(zip.entries.get(name)!, ""));
    }
    return finishEpub(file, outline, async (page) => {
      const blob = blobs.get(lookup(page.path) ?? "");
      return blob ? new Blob([blob], { type: page.mime }) : null;
    });
  }
  for (const name of byOffset(zip.entries, images)) {
    files[name] = await zip.bytes(zip.entries.get(name)!);
  }
  return finishEpub(file, parseEpubFiles(files));
}

/** A parsed EPUB → a comic volume (pages as Blobs: `pageBlob`, or the
    parsed bytes) when it is image-only, else a book. */
async function finishEpub(
  file: File,
  parsed: ParsedEpub,
  pageBlob: (page: EpubResource) => Promise<Blob | null> = async (page) =>
    new Blob([page.bytes as BlobPart], { type: page.mime }),
): Promise<ImportedBookFile> {
  const mangaPages = mangaPagesOf(parsed);
  if (mangaPages) {
    const pages: { path: string; blob: Blob }[] = [];
    for (const page of mangaPages) {
      const blob = await pageBlob(page);
      if (blob) pages.push({ path: page.path, blob });
    }
    const title = parsed.metadata.title.trim();
    const volume = await mangaVolumeFromEpub(
      title === "" || title === "Untitled" ? file.name.replace(/\.epub$/i, "") : title,
      pages,
    );
    if (volume) return { kind: "manga", volume };
  }
  let cover: string | undefined;
  if (parsed.cover) {
    try {
      cover = await blobToDataUrl(
        new Blob([parsed.cover.bytes as BlobPart], { type: parsed.cover.mime }),
      );
    } catch {
      // cover is best-effort
    }
  }
  return finalize(file, {
    format: "epub",
    title: parsed.metadata.title,
    author: parsed.metadata.creator,
    language: toLanguage(parsed.metadata.language),
    chapters: parsed.chapters,
    // Real NCX/nav when the book has one; chapter-derived otherwise.
    toc: parsed.toc.length > 0 ? parsed.toc : deriveToc(parsed.chapters),
    cover,
    resources: parsed.resources,
    bookCss: parsed.bookCss,
  });
}

// Shared fallbacks: title from the file name when metadata says nothing,
// language sniffed from the text when the file doesn't declare it (PDFs,
// sloppy EPUBs) — it drives writing-mode and the shelf's language grouping.
function finalize(
  file: File,
  imported: Omit<ImportedFile, "title"> & { title?: string },
): ImportedBookFile {
  const title =
    imported.title && imported.title.trim() !== ""
      ? imported.title
      : file.name.replace(/\.(epub|pdf)$/i, "");
  const language =
    imported.language ??
    detectLanguage(
      imported.chapters
        .slice(0, 3)
        .map((chapter) => chapter.html)
        .join(""),
    );
  return { kind: "book", ...imported, title, language };
}
