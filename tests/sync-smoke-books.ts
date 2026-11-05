import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";

// Books for tests/sync-smoke.ts, built on the fly.

// --- Books ------------------------------------------------------------------
export function epub(title: string, sentence: string): Uint8Array {
  const body = Array.from({ length: 2000 }, (_, i) => `<p>${sentence}${i}。</p>`).join("");
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oasis.opendocument.package"/></rootfiles></container>`),
    "content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`),
    "c1.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`),
  });
}

// A mokuro volume: page images plus a sidecar with a box on every page, so
// the in-app OCR has nothing to do. Returns the files to import.
export async function mangaVolume(root: string, title: string, colors: string[], width: number, height: number): Promise<string[]> {
  const folder = join(root, title);
  mkdirSync(folder);
  const pages: string[] = [];
  for (const [i, color] of colors.entries()) {
    const path = join(folder, `p${i + 1}.png`);
    await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(path);
    pages.push(path);
  }
  const sidecar = join(folder, `${title} 第01巻.mokuro`);
  writeFileSync(sidecar, JSON.stringify({
    version: "0.2.1",
    title,
    volume: `${title} 第01巻`,
    pages: pages.map((_, i) => ({
      img_path: `p${i + 1}.png`, img_width: width, img_height: height,
      blocks: [{ box: [20, 20, 120, 160], vertical: true, font_size: 24, lines: ["テスト"] }],
    })),
  }));
  return [...pages, sidecar];
}

// A volume of scans with no sidecar: every page needs in-app OCR. One zip,
// so the archive name becomes the title.
export async function bareVolume(root: string, title: string, colors: string[]): Promise<string> {
  const pages: Record<string, Uint8Array> = {};
  for (const [i, color] of colors.entries()) {
    pages[`p${i + 1}.png`] = new Uint8Array(await sharp({ create: { width: 300, height: 420, channels: 3, background: color } }).png().toBuffer());
  }
  const path = join(root, `${title}.zip`);
  writeFileSync(path, zipSync(pages));
  return path;
}
