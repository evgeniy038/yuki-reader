import { strFromU8, unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type {
  Chapter,
  EpubMetadata,
  EpubResource,
  ParsedEpub,
  TocEntry,
} from "./reading";

// EPUB parser: container -> OPF -> spine chapters, plus packed images as bytes,
// concatenated book CSS, and the cover. Image references inside chapter HTML
// are rewritten to a dummy data-URL that carries the resource path as a token;
// at render time the UI swaps those tokens for blob object-URLs. File lookup
// is case-insensitive (many epubs have mismatched case between OPF hrefs and
// zip entries). This keeps the core browser-free and node-testable.

const DUMMY_BASE = "data:image/gif;yuki:";
const DUMMY_SUFFIX = ";base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
function dummy(path: string): string {
  return `${DUMMY_BASE}${path}${DUMMY_SUFFIX}`;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

function child(obj: unknown, name: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const colon = key.indexOf(":");
    if ((colon === -1 ? key : key.slice(colon + 1)) === name) return value;
  }
  return undefined;
}

function attr(obj: unknown, name: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    let k = key;
    if (k.startsWith("@_")) k = k.slice(2);
    const colon = k.indexOf(":");
    if ((colon === -1 ? k : k.slice(colon + 1)) === name) return value;
  }
  return undefined;
}

function getStr(obj: unknown, name: string): string | undefined {
  const value = attr(obj, name);
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in (value as object)) {
    const t = (value as Record<string, unknown>)["#text"];
    return typeof t === "string" ? t : undefined;
  }
  return undefined;
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function titleFromHtml(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const plain = match[1]!.replace(/<[^>]+>/g, "").trim();
  return plain === "" ? undefined : plain;
}

// Infer image MIME from file extension when the OPF media-type is wrong/missing.
function mimeFromExt(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    default:
      return undefined;
  }
}

// Infer image MIME from magic bytes (first few bytes of the file).
function mimeFromMagic(bytes: Uint8Array): string | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return undefined;
}

function fixMime(mime: string, path: string, bytes: Uint8Array): string {
  if (mime.startsWith("image/")) return mime;
  return mimeFromExt(path) ?? mimeFromMagic(bytes) ?? "image/jpeg";
}

// Rewrite <img src> / <image href|xlink:href> that point at packed resources to
// the dummy token URL; leave external / data / anchor refs untouched.
function rewriteImages(
  html: string,
  chapterDir: string,
  resourcePaths: Set<string>,
): string {
  const resolve = (val: string): string => {
    if (/^(data:|https?:|#|mailto:)/i.test(val)) return val;
    const resolved = normalize(chapterDir ? `${chapterDir}/${val}` : val);
    return resourcePaths.has(resolved) ? dummy(resolved) : val;
  };
  const replaceAttr = (
    source: string,
    tag: string,
    attrPattern: string,
  ): string =>
    source.replace(
      new RegExp(`(<${tag}\\b[^>]*?\\s${attrPattern}\\s*=\\s*)(["'])([^"']*?)\\2`, "gi"),
      (_m, pre: string, q: string, val: string) => `${pre}${q}${resolve(val)}${q}`,
    );
  let out = html;
  out = replaceAttr(out, "img", "src");
  out = replaceAttr(out, "image", "(?:xlink:)?href");
  return out;
}

// <svg> width/height attributes pin the intrinsic viewport size and fight the
// reader's max-width/max-height constraints — drop them so CSS owns sizing.
function stripSvgSize(html: string): string {
  return html.replace(/<svg\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, "")
      .replace(/\s(?:width|height)\s*=\s*'[^']*'/gi, ""),
  );
}

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

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  const rawFiles = unzipSync(bytes);

  // Case-insensitive file lookup: many epubs have mismatched case between OPF
  // hrefs and actual zip entry paths.
  const lowerMap = new Map<string, string>();
  for (const key of Object.keys(rawFiles)) {
    lowerMap.set(key.toLowerCase(), key);
  }
  const findBytes = (path: string): Uint8Array | undefined => {
    return rawFiles[path] ?? rawFiles[lowerMap.get(path.toLowerCase()) ?? ""];
  };
  const read = (filename: string): string => {
    const entry = findBytes(filename);
    return entry ? strFromU8(entry) : "";
  };

  const containerDoc = xml.parse(read("META-INF/container.xml"));
  const container = child(containerDoc, "container") ?? containerDoc;
  const rootfile = asArray(child(child(container, "rootfiles"), "rootfile"))[0];
  const opfPath = getStr(rootfile, "full-path");
  if (!opfPath) throw new Error("EPUB: missing rootfile full-path in container.xml");
  const opfDirPath = dirOf(opfPath);

  const opfDoc = xml.parse(read(opfPath));
  const pkg = child(opfDoc, "package") ?? opfDoc;
  const metadataNode = child(pkg, "metadata");
  const metadata: EpubMetadata = {
    title: text(child(metadataNode, "title")) ?? "Untitled",
    creator: text(child(metadataNode, "creator")),
    language: text(child(metadataNode, "language")),
  };

  const items = asArray(child(child(pkg, "manifest"), "item"));
  const hrefById = new Map<string, string>();
  for (const item of items) {
    const id = getStr(item, "id");
    const href = getStr(item, "href");
    if (id && href) hrefById.set(id, href);
  }

  // Resources (images -> bytes) + book CSS (text/css -> concatenated raw text).
  // Images with wrong/missing MIME (e.g. application/octet-stream) are recovered
  // by extension / magic-byte sniffing so they still render.
  const resources: EpubResource[] = [];
  const resourcePaths = new Set<string>();
  let bookCss = "";
  for (const item of items) {
    const href = getStr(item, "href");
    const mt = getStr(item, "media-type");
    if (!href || !mt) continue;
    const resolved = normalize(opfDirPath ? `${opfDirPath}/${href}` : href);
    const isImage = mt.startsWith("image/");
    const isCss = mt === "text/css";
    if (isImage || (!isCss && mimeFromExt(resolved))) {
      const u8 = findBytes(resolved);
      if (u8) {
        const mime = isImage ? mt : fixMime(mt, resolved, u8);
        resources.push({ path: resolved, mime, bytes: u8 });
        resourcePaths.add(resolved);
      }
    } else if (isCss) {
      const css = read(resolved);
      if (css) bookCss += `${css}\n`;
    }
  }

  // Cover resolution with multiple fallbacks:
  // 1. OPF3 properties="cover-image" on manifest item
  // 2. OPF2 <meta name="cover" content="ID">
  // 3. OPF3 <meta property="cover-image">ID</meta>
  // 4. ID heuristic (id contains "cover")
  // 5. Filename heuristic (cover.jpg/png/gif/webp in zip)
  // 6. First image resource
  let coverId: string | undefined;
  for (const meta of asArray(child(metadataNode, "meta"))) {
    if (getStr(meta, "name") === "cover") coverId = getStr(meta, "content");
    // OPF3: <meta property="cover-image">some-id</meta>
    if (getStr(meta, "property") === "cover-image") coverId = text(meta);
  }
  let coverHref: string | undefined;
  let coverMime: string | undefined;
  // 1. OPF3 properties="cover-image"
  for (const item of items) {
    const props = getStr(item, "properties");
    if (props && props.split(/\s+/).includes("cover-image")) {
      coverHref = getStr(item, "href");
      coverMime = getStr(item, "media-type");
    }
  }
  // 2 + 3. OPF2/3 meta → match by id
  if (!coverHref && coverId) {
    for (const item of items) {
      if (getStr(item, "id") === coverId) {
        coverHref = getStr(item, "href");
        coverMime = getStr(item, "media-type");
      }
    }
  }
  // 4. ID heuristic
  if (!coverHref) {
    for (const item of items) {
      const mt = getStr(item, "media-type");
      const id = getStr(item, "id");
      if (mt && mt.startsWith("image/") && id && /cover/i.test(id)) {
        coverHref = getStr(item, "href");
        coverMime = mt;
      }
    }
  }
  // 5. Filename heuristic: look for cover.* in zip entries
  if (!coverHref) {
    for (const key of Object.keys(rawFiles)) {
      const base = key.split("/").pop()?.toLowerCase() ?? "";
      if (/^cover\.(jpe?g|png|gif|webp)$/i.test(base)) {
        coverHref = key.startsWith(opfDirPath + "/")
          ? key.slice(opfDirPath.length + 1)
          : key;
        coverMime = mimeFromExt(key);
        break;
      }
    }
  }
  // Build cover object with MIME fixup
  let cover: { mime: string; bytes: Uint8Array } | undefined;
  if (coverHref) {
    const resolved = normalize(opfDirPath ? `${opfDirPath}/${coverHref}` : coverHref);
    const u8 = findBytes(resolved);
    if (u8) {
      const mime = fixMime(coverMime ?? "", resolved, u8);
      cover = { mime, bytes: u8 };
    }
  }
  // 6. First image resource as last resort
  if (!cover && resources.length > 0) {
    const first = resources[0]!;
    const mime = fixMime(first.mime, first.path, first.bytes);
    cover = { mime, bytes: first.bytes };
  }

  const chapters: Chapter[] = [];
  for (const ref of asArray(child(child(pkg, "spine"), "itemref"))) {
    const idref = getStr(ref, "idref");
    if (!idref) continue;
    const href = hrefById.get(idref);
    if (!href) continue;
    const resolved = normalize(opfDirPath ? `${opfDirPath}/${href}` : href);
    const raw = read(resolved);
    if (raw === "") continue;
    const html = stripSvgSize(rewriteImages(raw, dirOf(resolved), resourcePaths));
    chapters.push({ id: idref, title: titleFromHtml(html), html });
  }

  // Table of contents: EPUB3 nav document first, else the EPUB2 NCX. Entries
  // map to spine chapters by resolved file path; in-file anchors are dropped —
  // a TOC jump lands at the section start.
  const idByResolvedPath = new Map<string, string>();
  for (const item of items) {
    const id = getStr(item, "id");
    const href = getStr(item, "href");
    if (id && href) {
      idByResolvedPath.set(normalize(opfDirPath ? `${opfDirPath}/${href}` : href), id);
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
  const tocResolved = tocHref
    ? normalize(opfDirPath ? `${opfDirPath}/${tocHref}` : tocHref)
    : "";
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
    const resolved = normalize(tocDir ? `${tocDir}/${clean}` : clean);
    const chapterId = idByResolvedPath.get(resolved);
    const trimmed = label.replace(/\s+/g, " ").trim();
    if (chapterId && trimmed !== "") {
      tocResolvedEntries.push({ label: trimmed, chapterId });
    }
  }
  // Consecutive duplicates: nested points often repeat the parent's target.
  const toc = tocResolvedEntries.filter(
    (entry, index) =>
      index === 0 || entry.chapterId !== tocResolvedEntries[index - 1]!.chapterId,
  );

  return { metadata, chapters, toc, cover, resources, bookCss };
}
