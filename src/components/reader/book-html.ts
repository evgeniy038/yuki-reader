import type { Chapter, EpubResource } from "@/core/reading";
import { scopeBookCss } from "@/core/book-css";
import { measureSection } from "@/core/reading-stats";

const DUMMY_PREFIX = "data:image/gif;yuki:";
const DUMMY_SUFFIX = ";base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

/** One spine section, ready to render on its own (per-section reader). */
interface ArticleSection {
  /** Spine id (the TOC's chapterId). */
  id: string;
  /** Ready-to-inject <section data-chapter> markup, resources swapped. */
  html: string;
  /** Countable characters in the section. */
  chars: number;
  /** Global char offset where the section starts (prefix sums over chars). */
  offset: number;
}

export interface ArticleBuild {
  /** The book's spine sections in reading order. */
  sections: ArticleSection[];
  /** Total countable characters in the book. */
  total: number;
  /** Every countable node's raw text + global char offset — the search index. */
  index: { text: string; offset: number }[];
  /** Inline <style> content hoisted from chapters, already scoped. */
  inlineCss: string;
  /** Blob object URLs created for resources — revoke on teardown. */
  urls: string[];
}

// Build the reader's section model from raw chapters:
//   1. every resource gets a blob object URL (images, fonts);
//   2. each chapter is parsed ONCE — scripts stripped, inline <style> hoisted
//      (book CSS keys off them later), the chapter's <html>/<body> classes
//      (hltr/vrtl, p-titlepage/...) saved for the section wrapper, anchors
//      counted (front-matter detection below);
//   3. illustrations after the front matter get wrapped in a centering
//      container (the reference reader's img-parent): every img that is not a
//      gaiji glyph, and every svg holding a raster image. Gaiji images are
//      inline text glyphs and stay in the flow unwrapped; front matter keeps
//      its authored layout;
//   4. dummy resource tokens become blob URLs — at DOM level, by exact token
//      match on the attribute, not by scanning the HTML string per resource;
//   5. each section is measured (chars + search index) from the SAME parsed
//      tree, so book-wide char offsets are known without laying anything out.
export function buildArticle(
  chapters: Chapter[],
  resources: EpubResource[] | undefined,
): ArticleBuild {
  const urls: string[] = [];
  const map = new Map<string, string>();
  for (const resource of resources ?? []) {
    const url = URL.createObjectURL(
      new Blob([resource.bytes as BlobPart], { type: resource.mime }),
    );
    map.set(resource.path, url);
    urls.push(url);
  }

  // Swap a dummy resource token (the full data-URL form, or the bare
  // yuki:PATH remnant) for the resource's blob URL; exact matches only.
  const swapResource = (el: Element, attr: string): void => {
    const value = el.getAttribute(attr);
    if (!value) return;
    let path: string | undefined;
    if (value.startsWith(DUMMY_PREFIX) && value.endsWith(DUMMY_SUFFIX)) {
      path = value.slice(DUMMY_PREFIX.length, value.length - DUMMY_SUFFIX.length);
    } else if (value.startsWith("yuki:")) {
      path = value.slice("yuki:".length);
    }
    const url = path === undefined ? undefined : map.get(path);
    if (url) el.setAttribute(attr, url);
  };

  const parser = typeof DOMParser === "undefined" ? null : new DOMParser();
  const parsed: {
    id: string;
    html: string;
    body: HTMLElement | null;
    chapterClass: string;
    anchors: number;
  }[] = [];
  let inlineCss = "";
  for (const chapter of chapters) {
    const html = chapter.html.replace(/<script[\s\S]*?<\/script>/gi, "");
    let body: HTMLElement | null = null;
    let chapterClass = "";
    let anchors = 0;
    if (parser && html !== "") {
      const doc = parser.parseFromString(html, "text/html");
      doc.querySelectorAll("style").forEach((styleEl) => {
        inlineCss += `${styleEl.textContent ?? ""}\n`;
        styleEl.remove();
      });
      body = doc.body;
      chapterClass = [doc.documentElement.className, body.className]
        .filter(Boolean)
        .join(" ")
        .replace(/"/g, "");
      anchors = body.getElementsByTagName("a").length;
    }
    parsed.push({ id: chapter.id, html, body, chapterClass, anchors });
  }

  // The front matter ends at the first chapter with real navigation anchors
  // (the book's own toc page); only chapters AFTER it get image wrapping.
  const tocIndex = parsed.findIndex((c) => c.anchors > 1);
  const sections: ArticleSection[] = [];
  const index: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const [chapterIndex, chapter] of parsed.entries()) {
    const { body } = chapter;
    let chars = 0;
    if (body) {
      const wrapImages = tocIndex !== -1 && chapterIndex > tocIndex;
      for (const img of Array.from(body.querySelectorAll("img"))) {
        swapResource(img, "src");
        if (!wrapImages) continue;
        if (Array.from(img.classList).some((c) => c.includes("gaiji"))) continue;
        const wrap = body.ownerDocument.createElement("span");
        wrap.className = "image-wrap";
        img.parentElement!.insertBefore(wrap, img);
        wrap.appendChild(img);
      }
      if (wrapImages) {
        for (const svg of Array.from(body.querySelectorAll("svg"))) {
          if (svg.getElementsByTagName("image").length === 0) continue;
          const wrap = body.ownerDocument.createElement("span");
          wrap.className = "image-wrap";
          svg.parentElement!.insertBefore(wrap, svg);
          wrap.appendChild(svg);
        }
      }
      for (const image of Array.from(body.querySelectorAll("image"))) {
        swapResource(image, "href");
        swapResource(image, "xlink:href");
      }
      const measured = measureSection(body, offset);
      chars = measured.chars;
      index.push(...measured.index);
      chapter.html = body.innerHTML;
    }
    const classAttr =
      chapter.chapterClass === "" ? "" : ` class="${chapter.chapterClass}"`;
    sections.push({
      id: chapter.id,
      html: `<section data-chapter="${chapter.id}"${classAttr}>${chapter.html}</section>`,
      chars,
      offset,
    });
    offset += chars;
  }

  return { sections, total: offset, index, inlineCss: scopeBookCss(inlineCss), urls };
}
