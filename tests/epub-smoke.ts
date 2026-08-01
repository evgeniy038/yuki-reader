import { strict as assert } from "node:assert";
import { strToU8, zipSync } from "fflate";
import { parseEpub } from "../src/core/epub.ts";

const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`;

// Note the dc: prefixes — this also exercises namespace-prefix stripping.
const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>雪国テスト</dc:title><dc:creator>川端</dc:creator><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="chapter%202.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;

const chapterXml = `<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><p>国境の長いトンネル</p></body></html>`;

function buildEpub(): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(containerXml),
    "content.opf": strToU8(opfXml),
    "ch1.xhtml": strToU8(chapterXml),
    "chapter 2.xhtml": strToU8(chapterXml.replace("第一章", "第二章")),
  });
}

function main(): void {
  const parsed = parseEpub(buildEpub());

  assert.equal(parsed.metadata.title, "雪国テスト");
  assert.equal(parsed.metadata.creator, "川端");
  assert.equal(parsed.metadata.language, "ja");
  assert.equal(parsed.chapters.length, 2);
  assert.equal(parsed.chapters[0]!.id, "c1");
  assert.equal(parsed.chapters[0]!.title, "第一章");
  assert.ok(parsed.chapters[0]!.html.includes("国境の長いトンネル"));
  assert.equal(parsed.chapters[1]!.id, "c2");
  assert.equal(parsed.chapters[1]!.title, "第二章");

  console.log("EPUB parser smoke: PASS");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
