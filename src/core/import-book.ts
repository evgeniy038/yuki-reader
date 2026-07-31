import { parseEpub } from "./epub";
import { importPdf } from "./pdf";
import { detectLanguage, type BookFormat, type Language } from "./library";
import { deriveToc, type Chapter, type EpubResource, type TocEntry } from "./reading";

// Book-file import pipeline: raw file → everything the shelf and the readers
// need. One place owns the EPUB/PDF split and every fallback (title from the
// filename, language sniffed from the text, TOC derived when the book has no
// NCX/nav), so App's `openFile` is just: import → dedupe → store → open.

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

function toLanguage(code: string | undefined): Language | undefined {
  const c = (code ?? "").toLowerCase();
  if (c.startsWith("ja")) return "ja";
  if (c.startsWith("en")) return "en";
  return undefined;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function importBookFile(file: File): Promise<ImportedFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    // PDF: pages are rendered straight from the stored bytes at read time.
    // Import keeps only a text sample (language + dup hash), the page count,
    // and a cover render — no reflowed text, so ugly PDFs (scans, formulas,
    // layouts) survive untouched.
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

  const parsed = parseEpub(bytes);
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
): ImportedFile {
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
  return { ...imported, title, language };
}
