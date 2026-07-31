import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { parseEpub } from "../src/core/epub.ts";

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`;

// Note: img href uses lowercase "images" but the zip entry uses "Images" (case mismatch).
const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
<metadata><dc:title>Resource Test</dc:title><dc:language>ja</dc:language></metadata>
<manifest>
<item id="css" href="style/book.css" media-type="text/css"/>
<item id="img" href="images/cover.png" media-type="application/octet-stream"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`;

const bookCss = `html { margin: 0; } body { background: #fff; } .indent { text-indent: 1em; color: #222; }`;

const chapterHtml = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>
<body><p class="indent">国境の長いトンネル</p><img src="../images/cover.png"/><image xlink:href="../images/cover.png"/><img src="https://example.com/x.png"/></body></html>`;

// Real PNG magic bytes (8-byte header + 1 payload byte).
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42]);

function main(): void {
  // Note: zip entry is "OEBPS/Images/cover.png" (capital I) but OPF href is "images/cover.png" (lowercase).
  const bytes = zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(containerXml),
    "OEBPS/content.opf": strToU8(opfXml),
    "OEBPS/style/book.css": strToU8(bookCss),
    "OEBPS/Images/cover.png": pngBytes,
    "OEBPS/text/ch1.xhtml": strToU8(chapterHtml),
  });

  const parsed = parseEpub(bytes);

  // Case-insensitive resource extraction: OPF says "images/cover.png", zip has "Images/cover.png".
  // The resource path should match the OPF-normalized path.
  const img = parsed.resources.find(
    (r) => r.path.toLowerCase() === "oebps/images/cover.png",
  );
  assert.ok(img, "image resource extracted (case-insensitive)");
  assert.deepEqual(Array.from(img!.bytes), Array.from(pngBytes));

  // MIME fixup: OPF said "application/octet-stream" but magic bytes say PNG.
  assert.equal(img!.mime, "image/png", "MIME fixed from magic bytes");

  // Cover extracted via filename heuristic (cover.png) with correct MIME.
  assert.ok(parsed.cover, "cover extracted");
  assert.equal(parsed.cover!.mime, "image/png", "cover MIME correct");
  assert.deepEqual(Array.from(parsed.cover!.bytes), Array.from(pngBytes));

  // Book CSS concatenated raw.
  assert.ok(parsed.bookCss.includes(".indent { text-indent: 1em; color: #222; }"));

  // Image refs rewritten to dummy token (case-insensitive match).
  const html = parsed.chapters[0]!.html;
  assert.ok(
    html.includes("data:image/gif;yuki:") && html.includes("cover.png"),
    "local img rewritten to dummy token",
  );
  assert.ok(html.includes('src="https://example.com/x.png"'), "external ref untouched");

  console.log("epub resources smoke: PASS");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
