import { XMLParser } from "fast-xml-parser";

// Shared helpers of the EPUB parser: namespace-blind XML accessors over the
// fast-xml-parser output, zip-path normalization/resolution (hrefs are URI
// references — decoded before matching), and the chapter-HTML rewrites
// (packed images → dummy token URLs the UI swaps for blob object-URLs at
// render time, svg size attributes dropped so CSS owns sizing).

const DUMMY_BASE = "data:image/gif;yuki:";
const DUMMY_SUFFIX = ";base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
function dummy(path: string): string {
  return `${DUMMY_BASE}${path}${DUMMY_SUFFIX}`;
}

/** Packed-resource paths a chapter references, in document order. */
export function packedImagePaths(html: string): string[] {
  const paths: string[] = [];
  let at = html.indexOf(DUMMY_BASE);
  while (at !== -1) {
    const start = at + DUMMY_BASE.length;
    const end = html.indexOf(DUMMY_SUFFIX, start);
    if (end === -1) break;
    paths.push(html.slice(start, end));
    at = html.indexOf(DUMMY_BASE, end);
  }
  return paths;
}

export const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

export function child(obj: unknown, name: string): unknown {
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

export function getStr(obj: unknown, name: string): string | undefined {
  const value = attr(obj, name);
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function text(value: unknown): string | undefined {
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

export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

// Hrefs in the OPF, NCX/nav and chapter HTML are URI references: percent-
// decoding maps them to actual zip paths ("chapter%201.xhtml" ->
// "chapter 1.xhtml"). A malformed sequence (a literal '%' in a name, e.g.
// "100%.xhtml") must not throw — keep the raw form.
export function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// Resolve an href against its base directory into a normalized zip path.
export function resolvePath(dir: string, href: string): string {
  const decoded = decodePath(href);
  return normalize(dir ? `${dir}/${decoded}` : decoded);
}

export function titleFromHtml(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const plain = match[1]!.replace(/<[^>]+>/g, "").trim();
  return plain === "" ? undefined : plain;
}

// Rewrite <img src> / <image href|xlink:href> that point at packed resources to
// the dummy token URL; leave external / data / anchor refs untouched.
export function rewriteImages(
  html: string,
  chapterDir: string,
  resourcePaths: Set<string>,
): string {
  const resolve = (val: string): string => {
    if (/^(data:|https?:|#|mailto:)/i.test(val)) return val;
    const resolved = resolvePath(chapterDir, val);
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
export function stripSvgSize(html: string): string {
  return html.replace(/<svg\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, "")
      .replace(/\s(?:width|height)\s*=\s*'[^']*'/gi, ""),
  );
}
