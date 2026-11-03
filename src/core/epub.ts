import { strFromU8, unzipSync } from "fflate";
import { mimeFromExtension } from "./mime";
import type {
  Chapter,
  EpubMetadata,
  EpubResource,
  ParsedEpub,
} from "./reading";
import {
  asArray,
  child,
  decodePath,
  dirOf,
  getStr,
  resolvePath,
  rewriteImages,
  stripSvgSize,
  text,
  titleFromHtml,
  xml,
} from "./epub-utils";
import { parseToc } from "./epub-toc";

// EPUB parser: container -> OPF -> spine chapters, plus packed images as bytes,
// concatenated book CSS, and the cover. Image references inside chapter HTML
// are rewritten to a dummy data-URL that carries the resource path as a token;
// at render time the UI swaps those tokens for blob object-URLs. File lookup
// is case-insensitive (many epubs have mismatched case between OPF hrefs and
// zip entries) and percent-tolerant: hrefs are URI references, so they are
// decoded before matching, and zip entries are also indexed under their
// decoded names for the reverse direction. This keeps the core browser-free
// and node-testable. XML/path/rewrite helpers live in epub-utils.ts, the TOC
// pass (NCX/nav) in epub-toc.ts.

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
  return mimeFromExtension(path) ?? mimeFromMagic(bytes) ?? "image/jpeg";
}

/** Zip entry name for a path the OPF/spine refers to — case-insensitive
    (many epubs have mismatched case between OPF hrefs and actual zip entry
    paths) and percent-tolerant: entries are additionally indexed under their
    percent-decoded names, so a plain href still finds an entry written in
    encoded form by a broken exporter. */
export function epubEntryLookup(
  names: string[],
): (path: string) => string | undefined {
  const exact = new Set(names);
  const lowerMap = new Map<string, string>();
  for (const key of names) {
    lowerMap.set(key.toLowerCase(), key);
    const decoded = decodePath(key).toLowerCase();
    if (!lowerMap.has(decoded)) lowerMap.set(decoded, key);
  }
  return (path) => (exact.has(path) ? path : lowerMap.get(path.toLowerCase()));
}

export function parseEpub(bytes: Uint8Array): ParsedEpub {
  return parseEpubFiles(unzipSync(bytes));
}

/** parseEpub over already unpacked entries (name → bytes). */
export function parseEpubFiles(rawFiles: Record<string, Uint8Array>): ParsedEpub {
  const lookup = epubEntryLookup(Object.keys(rawFiles));
  const findBytes = (path: string): Uint8Array | undefined => {
    const name = lookup(path);
    return name === undefined ? undefined : rawFiles[name];
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
    const resolved = resolvePath(opfDirPath, href);
    const isImage = mt.startsWith("image/");
    const isCss = mt === "text/css";
    if (isImage || (!isCss && mimeFromExtension(resolved))) {
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
        coverMime = mimeFromExtension(key);
        break;
      }
    }
  }
  // Build cover object with MIME fixup
  let cover: { mime: string; bytes: Uint8Array } | undefined;
  if (coverHref) {
    const resolved = resolvePath(opfDirPath, coverHref);
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
    const resolved = resolvePath(opfDirPath, href);
    const raw = read(resolved);
    if (raw === "") continue;
    const html = stripSvgSize(rewriteImages(raw, dirOf(resolved), resourcePaths));
    chapters.push({ id: idref, title: titleFromHtml(html), html });
  }

  const toc = parseToc(items, opfDirPath, read);

  return { metadata, chapters, toc, cover, resources, bookCss };
}
