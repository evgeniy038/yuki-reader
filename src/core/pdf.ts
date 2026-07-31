import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

// Static pdf.js assets copied from node_modules into public/pdfjs (cmaps for
// CJK PDFs, standard fonts for PDFs that don't embed them). Served by Vite in
// dev, copied into dist and precached by the service worker in production.
const PDFJS_ASSETS = `${import.meta.env.BASE_URL}pdfjs`;

interface PdfDocument {
  doc: PDFDocumentProxy;
  numPages: number;
}

// One loader for every pdf.js entry point, with cmaps and standard fonts
// wired: without them CJK PDFs and PDFs with unembedded base fonts render
// blank or garbled glyphs. The bytes are COPIED: pdf.js transfers the buffer
// to its worker (detaching the original), and the caller's copy must stay
// valid — it is what gets stored in IndexedDB and re-read on every open.
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const doc = await getDocument({
    data: bytes.slice(),
    cMapUrl: `${PDFJS_ASSETS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSETS}/standard_fonts/`,
  }).promise;
  return { doc, numPages: doc.numPages };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

// Collapse a page's text items into plain text, breaking lines on the EOL
// flags pdfjs provides.
function itemsToText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let buffer = "";
  for (const raw of items) {
    const item = raw as PdfTextItem;
    if (typeof item.str !== "string") continue;
    buffer += item.str;
    if (item.hasEOL) {
      if (buffer.trim() !== "") lines.push(buffer.trim());
      buffer = "";
    }
  }
  if (buffer.trim() !== "") lines.push(buffer.trim());
  return lines.join("\n");
}

interface PdfSearchResult {
  /** 1-based page number containing the match. */
  page: number;
  before: string;
  match: string;
  after: string;
}

// In-book search over the text layers, page by page, stopping at `max`
// matches — a 400-page book's text layers load lazily, so a broad query
// doesn't have to parse the whole document. Pages without a text layer
// (scans) just contribute nothing.
export async function searchPdf(
  doc: PDFDocumentProxy,
  query: string,
  max = 50,
  context = 18,
): Promise<PdfSearchResult[]> {
  const q = query.trim().toLowerCase();
  const out: PdfSearchResult[] = [];
  if (q === "") return out;
  for (let n = 1; n <= doc.numPages && out.length < max; n += 1) {
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = itemsToText(content.items).replace(/\s+/g, " ");
      const haystack = text.toLowerCase();
      let from = 0;
      while (out.length < max) {
        const at = haystack.indexOf(q, from);
        if (at === -1) break;
        out.push({
          page: n,
          before: text.slice(Math.max(0, at - context), at),
          match: text.slice(at, at + q.length),
          after: text.slice(at + q.length, at + q.length + context),
        });
        from = at + q.length;
      }
    } catch {
      // a page whose text extraction fails is skipped, not fatal
    }
  }
  return out;
}

// Flattened outline (PDF bookmarks): title + 1-based page, reading order,
// nesting flattened. Entries whose destination can't be resolved drop out.
export interface PdfOutlineEntry {
  title: string;
  page: number;
}

interface PdfOutlineItem {
  title?: unknown;
  dest?: unknown;
  items?: unknown;
}

export async function loadPdfOutline(doc: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const out: PdfOutlineEntry[] = [];
  const walk = async (items: readonly PdfOutlineItem[] | null): Promise<void> => {
    for (const item of items ?? []) {
      const title = typeof item.title === "string" ? item.title.trim() : "";
      let page: number | null = null;
      try {
        const dest =
          typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref) page = (await doc.getPageIndex(ref)) + 1;
      } catch {
        // unresolvable destination — the entry is skipped below
      }
      if (title !== "" && page !== null) out.push({ title, page });
      await walk(
        Array.isArray(item.items) ? (item.items as PdfOutlineItem[]) : null,
      );
    }
  };
  try {
    await walk(await doc.getOutline());
  } catch {
    // no outline or a broken one — the book just has no TOC
  }
  return out;
}

interface PdfImport {
  metadata: { title?: string };
  numPages: number;
  /** Text sampled from a handful of pages — language sniffing + dup hash. */
  sampleHtml: string;
  /** First page rendered to a data URL for the shelf cover. */
  cover?: string;
}

// Page indices sampled for text: start, a few spread through the middle, end.
// PDF text is never stored whole — the reader renders pages, not reflowed
// text — so a sample is enough for language detection and the dup hash.
function samplePageIndices(numPages: number): number[] {
  const indices = new Set<number>([1, 2, 3]);
  for (const fraction of [0.25, 0.5, 0.75]) {
    indices.add(Math.max(1, Math.round(numPages * fraction)));
  }
  indices.add(numPages);
  return [...indices].filter((n) => n <= numPages).sort((a, b) => a - b);
}

// Import-time pass over the PDF: metadata, page count, a text sample, and the
// cover render. Text extraction is best-effort per page — image-only pages
// (scans) just contribute nothing.
export async function importPdf(bytes: Uint8Array): Promise<PdfImport> {
  const { doc, numPages } = await openPdf(bytes);

  let title: string | undefined;
  try {
    const { info } = await doc.getMetadata();
    const rawTitle = (info as { Title?: unknown } | null)?.Title;
    if (typeof rawTitle === "string" && rawTitle.trim() !== "") {
      title = rawTitle.trim();
    }
  } catch {
    // metadata is best-effort
  }

  const samples: string[] = [];
  for (const pageNumber of samplePageIndices(numPages)) {
    try {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      if (text !== "") samples.push(text);
    } catch {
      // a page that fails text extraction is not a reason to fail the import
    }
  }

  let cover: string | undefined;
  try {
    cover = await renderPdfPage(await doc.getPage(1), 480);
  } catch {
    // cover is best-effort — the shelf falls back to the placeholder
  }

  await doc.destroy();
  return {
    metadata: { title },
    numPages,
    sampleHtml: samples.map((text) => `<p>${escapeHtml(text)}</p>`).join(""),
    cover,
  };
}

// Render one page to a JPEG data URL at the given width (shelf covers).
async function renderPdfPage(
  page: PDFPageProxy,
  targetWidth: number,
): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL("image/jpeg", 0.85);
}

interface RenderedPdfPage {
  canvas: HTMLCanvasElement;
  textLayer: HTMLDivElement;
  width: number;
  height: number;
}

// Render one page for the reader: the page itself on a canvas (exact
// fidelity — layouts, formulas, scans all survive) plus pdf.js's text layer
// on top — invisible absolutely-positioned spans that make text selectable.
export async function renderPdfPageView(
  page: PDFPageProxy,
  scale: number,
  pixelRatio: number,
): Promise<RenderedPdfPage> {
  const viewport = page.getViewport({ scale: scale * pixelRatio });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width / pixelRatio}px`;
  canvas.style.height = `${height / pixelRatio}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;

  // The text layer positions spans against the CSS-size viewport (no pixel
  // ratio) — it lives on top of the canvas at 1:1 CSS scale.
  const cssViewport = page.getViewport({ scale });
  const textLayer = document.createElement("div");
  textLayer.className = "pdf-text-layer";
  // pdf.js sizes the layer and its spans via --scale-factor (in CSS units).
  textLayer.style.setProperty("--scale-factor", String(scale));
  const layer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container: textLayer,
    viewport: cssViewport,
  });
  await layer.render();

  return { canvas, textLayer, width: width / pixelRatio, height: height / pixelRatio };
}
