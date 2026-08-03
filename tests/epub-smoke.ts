import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { parseEpub } from "../src/core/epub.ts";

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

function main(): void {
  testBasic();
  testEncodedHref();
  testEncodedEntry();
  testEncodedImage();
  testLiteralPercentName();
  testNonAsciiEncodedHref();
  console.log("EPUB parser smoke: PASS");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
