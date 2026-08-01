// Node unit test for OCR model downloads (src/core/ocr/download.ts).
// The aggregate progress must never exceed 100% — even when the server
// hides Content-Length (a VPN/proxy turning responses chunked caused the
// 140%/323% bug) — broken streams must resume and retry, range-ignoring
// servers get the plain whole-file stream, and a dead network rejects after
// a few bounded attempts. global fetch is mocked; IndexedDB is absent in
// node, so the model cache silently no-ops (that path is intentional).
// Run: pnpm tsx tests/ocr-download.ts

import { strict as assert } from "node:assert";
import {
  downloadFiles,
  type OcrModelFiles,
} from "../src/core/ocr/download.ts";

const MB = 1024 * 1024;
const URLS: Record<keyof OcrModelFiles, string> = {
  detector: "https://models.test/detector.onnx",
  encoder: "https://models.test/encoder.onnx",
  decoder: "https://cdn.app.test/ocr-models/decoder.onnx",
  vocab: "https://models.test/vocab.txt",
};
const SIZES: Record<keyof OcrModelFiles, number> = {
  detector: 20 * MB,
  encoder: 9 * MB,
  decoder: 3 * MB,
  vocab: 24 * 1024,
};
const GRAND_TOTAL = Object.values(SIZES).reduce((sum, n) => sum + n, 0);

// --- mock network -----------------------------------------------------------

const byteAt = (i: number) => i % 251;

interface MockFile {
  size: number;
  chunked?: boolean; // never reveal Content-Length
  ignoreRange?: boolean; // answer 200 to ranged GETs
  dropGet?: number; // kill this GET ordinal (probe counts) mid-stream
  headDrops?: number; // fail this many HEAD requests first
  dead?: boolean; // every request network-errors
  // filled by the mock:
  getCount: number;
  resumed: boolean;
}

function bodyStream(
  start: number,
  end: number,
  dropAt?: number,
): ReadableStream<Uint8Array> {
  let sent = 0;
  const size = end - start;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      if (dropAt !== undefined && sent >= dropAt) {
        controller.error(new Error("socket hangup"));
        return;
      }
      const n = Math.min(
        65536,
        size - sent,
        dropAt === undefined ? size : dropAt - sent,
      );
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = byteAt(start + sent + i);
      sent += n;
      controller.enqueue(buf);
    },
  });
}

function mockNetwork(specs: Partial<Record<keyof OcrModelFiles, MockFile>>) {
  const files = new Map<string, MockFile>();
  for (const [key, spec] of Object.entries(specs)) {
    files.set(URLS[key as keyof OcrModelFiles], {
      getCount: 0,
      resumed: false,
      ...spec,
    });
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const file = files.get(url);
    if (!file) throw new TypeError(`unexpected URL: ${url}`);
    if (file.dead) throw new TypeError("network down");
    if ((init?.method ?? "GET") === "HEAD") {
      if (file.headDrops) {
        file.headDrops -= 1;
        throw new TypeError("network down");
      }
      return new Response(null, {
        status: 200,
        headers: file.chunked
          ? {}
          : { "content-length": String(file.size) },
      });
    }
    file.getCount += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.Range ?? "");
    const dropAt =
      file.dropGet === file.getCount
        ? Math.max(1, Math.floor(file.size / 3))
        : undefined;
    if (!range || file.ignoreRange) {
      return new Response(bodyStream(0, file.size, dropAt), {
        status: 200,
        headers: file.chunked
          ? {}
          : { "content-length": String(file.size) },
      });
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : file.size - 1;
    if (start >= file.size || start > end) {
      return new Response(null, { status: 416 });
    }
    if (start > 0) file.resumed = true;
    const length = Math.min(end, file.size - 1) - start + 1;
    return new Response(bodyStream(start, start + length, dropAt), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${start + length - 1}/${file.size}`,
        ...(file.chunked ? {} : { "content-length": String(length) }),
      },
    });
  }) as typeof fetch;
  return files;
}

// --- assertions ---------------------------------------------------------------

interface Emission {
  loaded: number;
  total: number;
}

function watch(): { emissions: Emission[]; onProgress: (l: number, t: number) => void } {
  const emissions: Emission[] = [];
  return {
    emissions,
    onProgress: (loaded, total) => emissions.push({ loaded, total }),
  };
}

const problems: string[] = [];
function check(ok: boolean, label: string): void {
  if (!ok) problems.push(label);
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}

function progressNeverOvershoots(
  label: string,
  emissions: Emission[],
): boolean {
  for (const { loaded, total } of emissions) {
    if (total > 0 ? loaded > total : loaded !== 0) {
      console.log(`    offending emission: ${loaded}/${total}`);
      return false;
    }
  }
  return true;
}

function landsExactlyAt100(emissions: Emission[]): boolean {
  const last = emissions.at(-1);
  return !!last && last.loaded === GRAND_TOTAL && last.total === GRAND_TOTAL;
}

function bytesMatch(label: string, files: OcrModelFiles): boolean {
  for (const key of Object.keys(SIZES) as (keyof OcrModelFiles)[]) {
    const bytes = files[key];
    if (bytes.length !== SIZES[key]) {
      console.log(`    ${label}: ${key} length ${bytes.length} ≠ ${SIZES[key]}`);
      return false;
    }
    for (let i = 0; i < bytes.length; i += 4093) {
      if (bytes[i] !== byteAt(i)) {
        console.log(`    ${label}: ${key} byte ${i} mismatch`);
        return false;
      }
    }
  }
  return true;
}

// --- scenarios ----------------------------------------------------------------

async function scenario(label: string, run: () => Promise<void>): Promise<void> {
  console.log(label);
  try {
    await run();
  } catch (err) {
    problems.push(`${label} threw`);
    console.log(`  ✗ threw: ${err instanceof Error ? err.message : err}`);
  }
}

await scenario("healthy network, sizes known", async () => {
  mockNetwork({
    detector: { size: SIZES.detector } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(URLS, w.onProgress);
  check(w.emissions.length > 10, "progress streams in many steps");
  check(progressNeverOvershoots("healthy", w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(bytesMatch("healthy", files), "bytes assemble correctly (ranged + whole)");
});

await scenario("chunked responses (no Content-Length — the VPN bug)", async () => {
  mockNetwork({
    detector: { size: SIZES.detector, chunked: true } as MockFile,
    encoder: { size: SIZES.encoder, chunked: true } as MockFile,
    decoder: { size: SIZES.decoder, chunked: true } as MockFile,
    vocab: { size: SIZES.vocab, chunked: true } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(URLS, w.onProgress);
  check(
    progressNeverOvershoots("chunked", w.emissions),
    "never exceeds 100% with hidden sizes",
  );
  check(landsExactlyAt100(w.emissions), "lands at exactly 100% once finished");
  check(bytesMatch("chunked", files), "bytes assemble correctly");
});

await scenario("dropped streams resume and retry", async () => {
  const files = mockNetwork({
    // GET #1 is the range probe, #2 the first part stream.
    detector: { size: SIZES.detector, dropGet: 2 } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    // GET #1 is the whole-file stream itself.
    decoder: { size: SIZES.decoder, dropGet: 1 } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const result = await downloadFiles(URLS, w.onProgress);
  check(progressNeverOvershoots("drops", w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(
    files.get(URLS.detector)!.resumed,
    "ranged part resumes from received bytes",
  );
  check(
    files.get(URLS.decoder)!.resumed,
    "whole-file stream resumes from received bytes",
  );
  check(bytesMatch("drops", result), "bytes assemble correctly after resume");
});

await scenario("server ignores Range (plain 200 everywhere)", async () => {
  mockNetwork({
    detector: { size: SIZES.detector, ignoreRange: true } as MockFile,
    encoder: { size: SIZES.encoder, ignoreRange: true } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(URLS, w.onProgress);
  check(progressNeverOvershoots("ignoreRange", w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(bytesMatch("ignoreRange", files), "whole-file fallback downloads right");
});

await scenario("flaky HEAD recovers", async () => {
  mockNetwork({
    detector: { size: SIZES.detector, headDrops: 2 } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(URLS, w.onProgress);
  check(landsExactlyAt100(w.emissions), "lands at exactly 100% after HEAD retries");
  check(bytesMatch("flaky-head", files), "bytes assemble correctly");
});

await scenario("dead network rejects, bounded attempts", async () => {
  mockNetwork({
    detector: { size: SIZES.detector, dead: true } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const started = Date.now();
  const failure = await downloadFiles(URLS, () => {}).then(
    () => null,
    (err: unknown) => err,
  );
  const elapsed = Date.now() - started;
  check(failure instanceof Error, "download rejects");
  check(elapsed < 10_000, `gives up fast (${elapsed}ms, 4 bounded attempts)`);
});

console.log();
if (problems.length > 0) {
  console.log(`FAIL: ${problems.length} problem(s)`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log("PASS: OCR downloads — progress is honest, transfers heal");
