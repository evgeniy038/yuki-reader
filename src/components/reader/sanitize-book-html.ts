// Book HTML is untrusted: an EPUB is a zip of somebody's XHTML, and the
// reader puts its chapters into the LIVE document. Stripping <script> alone
// is not enough — event-handler attributes (<img onerror>, <details
// ontoggle>, SVG <animate onbegin>), javascript: URLs and embedded browsing
// contexts run code in the app's origin, next to the library, the sync
// token and the encryption key. Everything that can execute or navigate is
// removed here, on the inert DOMParser tree, before the markup is ever
// serialized into the page. Remote media references go too: a book must not
// phone home (tracking pixels) when a page is shown.

// Elements removed with their whole subtree: script and browsing contexts,
// plugin embeds, forms (navigation), document-level tags that retarget or
// refresh the page, and SVG animation — it can rewrite href to javascript:.
const DROPPED = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "form",
  "base",
  "meta",
  "link",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "discard",
]);

// Attributes that carry a URL the browser may load or navigate to.
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "srcset",
  "poster",
  "background",
  "lowsrc",
  "dynsrc",
  "ping",
  "data",
]);

// Attributes with no legitimate use in a book that can run or submit things.
const DROPPED_ATTRS = new Set(["srcdoc", "formaction", "action"]);

// Elements whose URLs LOAD something when shown (as opposed to <a>, which
// only navigates on a deliberate tap): these may point only inside the book.
const MEDIA = new Set([
  "img",
  "image",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "use",
  "feimage",
  "input",
]);

/** Lower-case scheme of a URL attribute value, control chars and spaces
    removed the way browsers do before resolving ("java\tscript:" runs). */
function schemeOf(value: string): string {
  const compact = value.replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  const colon = compact.indexOf(":");
  if (colon === -1) return "";
  const scheme = compact.slice(0, colon);
  // A colon after "/", "?" or "#" belongs to a relative path, not a scheme.
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? scheme : "";
}

function allowedUrl(element: string, value: string): boolean {
  const scheme = schemeOf(value);
  if (scheme === "") {
    // Relative reference (internal chapter link, fragment) — except a
    // protocol-relative "//host" one, which is remote.
    return !(MEDIA.has(element) && value.trim().startsWith("//"));
  }
  // yuki: and data:image/… are the book's own resource tokens (see
  // epub-utils / book-html); blob: is what they become.
  if (scheme === "yuki" || scheme === "blob") return true;
  if (scheme === "data") return /^\s*data:image\//i.test(value);
  if (MEDIA.has(element)) return false;
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

/** Strip executable and network-reaching markup from a parsed chapter body,
    in place. */
export function sanitizeBookBody(body: Element): void {
  for (const element of Array.from(body.querySelectorAll("*"))) {
    const name = element.localName.toLowerCase();
    if (DROPPED.has(name)) {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const attrName = attr.name.toLowerCase();
      // srcset lists several candidates ("a.jpg 1x, b.jpg 2x"): every URL
      // in it must pass, not just the first.
      const urls =
        attrName === "srcset"
          ? attr.value.split(",").map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
          : [attr.value];
      const unsafe =
        attrName.startsWith("on") ||
        DROPPED_ATTRS.has(attrName) ||
        (URL_ATTRS.has(attrName) && urls.some((url) => !allowedUrl(name, url)));
      if (unsafe) element.removeAttributeNode(attr);
    }
  }
}
