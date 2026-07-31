// Probe the fixture PDFs: page counts, metadata, text-layer quality samples.
// Usage: YUKI_TEST_PDF_TEXT=… YUKI_TEST_PDF_SCAN=… pnpm tsx tests/pdf-probe.ts
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { requireEnv } from "./env.ts";

const FILES = [requireEnv("YUKI_TEST_PDF_TEXT"), requireEnv("YUKI_TEST_PDF_SCAN")];

for (const file of FILES) {
  const bytes = new Uint8Array(readFileSync(file));
  const doc = await getDocument({ data: bytes }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const title =
    meta && typeof (meta.info as { Title?: unknown }).Title === "string"
      ? (meta.info as { Title: string }).Title
      : "(none)";
  console.log(`\n=== ${file.split("/").pop()}`);
  console.log(`pages: ${doc.numPages}, title: ${title}`);

  const samplePages = [1, 2, 5, Math.floor(doc.numPages / 2), doc.numPages];
  for (const n of [...new Set(samplePages)]) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items = content.items as { str?: string; hasEOL?: boolean }[];
    const text = items
      .map((i) => i.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    console.log(
      `  p${n}: items=${items.length} chars=${text.length} :: ${text.slice(0, 140) || "(empty)"}`,
    );
  }
  await doc.destroy();
}
