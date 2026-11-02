import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { parseEpub } from "../src/core/epub.ts";
import { mangaPagesOf } from "../src/core/epub-manga.ts";

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`;

const containerXmlOebps = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`;

// Note the dc: prefixes — this also exercises namespace-prefix stripping.
const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>雪国テスト</dc:title><dc:creator>川端</dc:creator><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`;

const chapterXml = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><p>国境の長いトンネル</p></body></html>`;

function opfWith(items: string, spine: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><title>t</title></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`;
}

function epubWith(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
  };
  for (const [name, text] of Object.entries(files)) entries[name] = strToU8(text);
  return zipSync(entries);
}

function testBasic(): void {
  const parsed = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXml,
      "content.opf": opfXml,
      "ch1.xhtml": chapterXml,
    }),
  );

  assert.equal(parsed.metadata.title, "雪国テスト");
  assert.equal(parsed.metadata.creator, "川端");
  assert.equal(parsed.metadata.language, "ja");
  assert.equal(parsed.chapters.length, 1);
  assert.equal(parsed.chapters[0]!.id, "c1");
  assert.equal(parsed.chapters[0]!.title, "第一章");
  assert.ok(parsed.chapters[0]!.html.includes("国境の長いトンネル"));
}

// Issue #2 regression: the zip entry has a literal space while the OPF href is
// percent-encoded (the spec-compliant form). It must still resolve.
function testEncodedHref(): void {
  const opf = opfWith(
    `<item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<itemref idref="c1"/>`,
  );
  const ncx = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>One</text></navLabel><content src="chapter%201.xhtml"/></navPoint></navMap></ncx>`;
  const parsed = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXmlOebps,
      "OEBPS/content.opf": opf,
      "OEBPS/chapter 1.xhtml": chapterXml,
      "OEBPS/toc.ncx": ncx,
    }),
  );
  assert.equal(parsed.chapters.length, 1, "percent-encoded manifest href");
  assert.equal(parsed.chapters[0]!.id, "c1");
  assert.equal(parsed.toc.length, 1, "percent-encoded NCX src");
  assert.equal(parsed.toc[0]!.chapterId, "c1");
}

// Broken-tool direction: the zip entry itself is percent-encoded while the OPF
// href uses a plain space. The entry index must match it too.
function testEncodedEntry(): void {
  const opf = opfWith(
    `<item id="c1" href="chapter 1.xhtml" media-type="application/xhtml+xml"/>`,
    `<itemref idref="c1"/>`,
  );
  const parsed = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXml,
      "content.opf": opf,
      "chapter%201.xhtml": chapterXml,
    }),
  );
  assert.equal(parsed.chapters.length, 1, "percent-encoded zip entry");
}

// <img src> in chapter HTML is a URI too: an encoded src must match the
// manifest resource and be rewritten to the token URL.
function testEncodedImage(): void {
  const opf = opfWith(
    `<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="illust%20one.png" media-type="image/png"/>`,
    `<itemref idref="c1"/>`,
  );
  const chapter = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p><img src="illust%20one.png"/></p></body></html>`;
  const parsed = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXml,
      "content.opf": opf,
      "ch1.xhtml": chapter,
      "illust one.png": "not-really-a-png",
    }),
  );
  assert.equal(parsed.resources.length, 1, "encoded image href resolves");
  assert.equal(parsed.resources[0]!.path, "illust one.png");
  assert.equal(parsed.chapters.length, 1);
  assert.ok(
    parsed.chapters[0]!.html.includes("yuki:illust one.png"),
    "encoded img src rewritten to token",
  );
}

// A literal '%' in a file name is not a percent sequence: decoding must not
// throw or mangle the path, in both the encoded and the raw form.
function testLiteralPercentName(): void {
  const cases: Array<[string, string]> = [
    ["encoded href", "100%25.xhtml"],
    ["raw href", "100%.xhtml"],
  ];
  for (const [name, href] of cases) {
    const opf = opfWith(
      `<item id="c1" href="${href}" media-type="application/xhtml+xml"/>`,
      `<itemref idref="c1"/>`,
    );
    const parsed = parseEpub(
      epubWith({
        "META-INF/container.xml": containerXml,
        "content.opf": opf,
        "100%.xhtml": chapterXml,
      }),
    );
    assert.equal(parsed.chapters.length, 1, name);
  }
}

// Japanese file names travel percent-encoded in the OPF; they must resolve to
// the UTF-8 zip entry.
function testNonAsciiEncodedHref(): void {
  const name = "第一章.xhtml";
  const opf = opfWith(
    `<item id="c1" href="${encodeURIComponent(name)}" media-type="application/xhtml+xml"/>`,
    `<itemref idref="c1"/>`,
  );
  const parsed = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXml,
      "content.opf": opf,
      [name]: chapterXml,
    }),
  );
  assert.equal(parsed.chapters.length, 1, "non-ASCII percent-encoded href");
}

// Regression: a fixed-layout comic EPUB (store scans, calibre conversions) is
// a spine of page wrappers — <svg><image> or <img>, a <title>, no text. It
// must be recognized as manga with pages in spine order (not manifest order);
// a book whose only images are illustrations between text stays a book.
function testComicEpub(): void {
  const page = (img: string, svg: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ja">
<head><meta charset="UTF-8"/><title>漫画 1巻</title><link rel="stylesheet" type="text/css" href="../style/fixed-layout-jp.css"/></head>
<body><div class="main">${
    svg
      ? `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%" viewBox="0 0 1350 1920"><image width="1350" height="1920" xlink:href="../image/${img}"/></svg>`
      : `&#160;<img src="../image/${img}" alt=""/>`
  }</div></body></html>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>漫画 1巻</dc:title><meta property="rendition:layout">pre-paginated</meta></metadata><manifest>
<item id="i3" href="image/p3.jpg" media-type="image/jpeg"/>
<item id="i1" href="image/p1.jpg" media-type="image/jpeg"/>
<item id="i2" href="image/p2.jpg" media-type="image/jpeg"/>
<item id="p-1" href="xhtml/p-1.xhtml" media-type="application/xhtml+xml"/>
<item id="p-2" href="xhtml/p-2.xhtml" media-type="application/xhtml+xml"/>
<item id="p-3" href="xhtml/p-3.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine page-progression-direction="rtl"><itemref idref="p-1"/><itemref idref="p-2"/><itemref idref="p-3"/></spine></package>`;
  const comic = parseEpub(
    epubWith({
      "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="item/standard.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
      "item/standard.opf": opf,
      "item/xhtml/p-1.xhtml": page("p1.jpg", true),
      "item/xhtml/p-2.xhtml": page("p2.jpg", false),
      "item/xhtml/p-3.xhtml": page("p3.jpg", true),
      "item/image/p1.jpg": "one",
      "item/image/p2.jpg": "two",
      "item/image/p3.jpg": "three",
    }),
  );
  const pages = mangaPagesOf(comic);
  assert.ok(pages, "image-only EPUB detected as manga");
  assert.deepEqual(
    pages.map((p) => p.path),
    ["item/image/p1.jpg", "item/image/p2.jpg", "item/image/p3.jpg"],
    "pages follow the spine",
  );
  assert.equal(new TextDecoder().decode(pages[1]!.bytes), "two");

  const illustrated = parseEpub(
    epubWith({
      "META-INF/container.xml": containerXml,
      "content.opf": opfWith(
        `<item id="cv" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="img" href="cover.jpg" media-type="image/jpeg"/>`,
        `<itemref idref="cv"/><itemref idref="c1"/>`,
      ),
      "cover.xhtml": `<html><head><title>表紙</title></head><body><img src="cover.jpg"/></body></html>`,
      "ch1.xhtml": chapterXml,
      "cover.jpg": "cover",
    }),
  );
  assert.equal(mangaPagesOf(illustrated), null, "text chapters keep it a book");
  assert.equal(
    mangaPagesOf(
      parseEpub(
        epubWith({
          "META-INF/container.xml": containerXml,
          "content.opf": opfXml,
          "ch1.xhtml": `<html><head><title>空</title></head><body></body></html>`,
        }),
      ),
    ),
    null,
    "no text and no images is not manga",
  );
}

function main(): void {
  testBasic();
  testEncodedHref();
  testEncodedEntry();
  testEncodedImage();
  testLiteralPercentName();
  testNonAsciiEncodedHref();
  testComicEpub();
  console.log("EPUB parser smoke: PASS");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
