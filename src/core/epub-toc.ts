import type { TocEntry } from "./reading";
import { asArray, child, dirOf, getStr, resolvePath, xml } from "./epub-utils";

// --- Table of contents (EPUB2 NCX / EPUB3 nav document) --------------------

interface RawTocEntry {
  label: string;
  src: string;
}

// All text under a parsed XML node (fast-xml-parser splits text into #text).
function deepText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (node == null || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(deepText).join("");
  return Object.entries(node as Record<string, unknown>)
    .filter(([key]) => !key.startsWith("@_"))
    .map(([, value]) => deepText(value))
    .join("");
}

// NCX navMap: navPoints nest; reading order is the document order.
function walkNcx(navPoints: unknown, out: RawTocEntry[]): void {
  for (const navPoint of asArray(navPoints)) {
    const src = getStr(child(navPoint, "content"), "src");
    if (src) out.push({ label: deepText(child(navPoint, "navLabel")), src });
    walkNcx(child(navPoint, "navPoint"), out);
  }
}

// Nav document: <li><a href>…</a><ol>…</ol></li> nesting; same document order.
function walkNavItems(items: unknown, out: RawTocEntry[]): void {
  for (const li of asArray(items)) {
    const anchor = child(li, "a");
    const href = getStr(anchor, "href");
    if (href) out.push({ label: deepText(anchor), src: href });
    walkNavItems(child(child(li, "ol"), "li"), out);
  }
}

// Table of contents: EPUB3 nav document first, else the EPUB2 NCX. Entries
// map to spine chapters by resolved file path; in-file anchors are dropped —
// a TOC jump lands at the section start.
export function parseToc(
  items: unknown[],
  opfDirPath: string,
  read: (filename: string) => string,
): TocEntry[] {
  const idByResolvedPath = new Map<string, string>();
  for (const item of items) {
    const id = getStr(item, "id");
    const href = getStr(item, "href");
    if (id && href) {
      idByResolvedPath.set(resolvePath(opfDirPath, href), id);
    }
  }
  const rawToc: RawTocEntry[] = [];
  let tocDir = "";
  const navItem = items.find((item) =>
    (getStr(item, "properties") ?? "").split(/\s+/).includes("nav"),
  );
  const ncxItem = items.find(
    (item) => getStr(item, "media-type") === "application/x-dtbncx+xml",
  );
  const tocItem = navItem ?? ncxItem;
  const tocHref = tocItem ? getStr(tocItem, "href") : undefined;
  const tocResolved = tocHref ? resolvePath(opfDirPath, tocHref) : "";
  const tocRaw = tocResolved === "" ? "" : read(tocResolved);
  if (tocRaw !== "") {
    if (navItem) {
      const navDoc = xml.parse(tocRaw);
      const htmlEl = child(navDoc, "html") ?? navDoc;
      const body = child(htmlEl, "body") ?? htmlEl;
      for (const nav of asArray(child(body, "nav"))) {
        // Only the reading-order nav (skip landmarks/page-list).
        if (getStr(nav, "type") !== "toc") continue;
        walkNavItems(child(child(nav, "ol"), "li"), rawToc);
      }
    } else {
      const ncxDoc = xml.parse(tocRaw);
      const ncx = child(ncxDoc, "ncx") ?? ncxDoc;
      walkNcx(child(child(ncx, "navMap"), "navPoint"), rawToc);
    }
    tocDir = dirOf(tocResolved);
  }
  const tocResolvedEntries: TocEntry[] = [];
  for (const { label, src } of rawToc) {
    const clean = src.split("#")[0]!;
    const resolved = resolvePath(tocDir, clean);
    const chapterId = idByResolvedPath.get(resolved);
    const trimmed = label.replace(/\s+/g, " ").trim();
    if (chapterId && trimmed !== "") {
      tocResolvedEntries.push({ label: trimmed, chapterId });
    }
  }
  // Consecutive duplicates: nested points often repeat the parent's target.
  return tocResolvedEntries.filter(
    (entry, index) =>
      index === 0 || entry.chapterId !== tocResolvedEntries[index - 1]!.chapterId,
  );
}
