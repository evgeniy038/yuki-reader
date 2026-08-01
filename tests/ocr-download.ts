// Node unit test for OCR model downloads (src/core/ocr/download.ts).
// Model sizes are KNOWN (hardcoded per file), so the aggregate progress can
// never exceed 100% — the VPN/proxy bug where hidden Content-Length sent it
// to 140%/323% — broken streams resume from received bytes and retry,
// range-ignoring servers get the plain whole-file stream, and a truncated
// or dead network rejects after a few bounded attempts instead of caching
// poison. global fetch is mocked; IndexedDB is absent in node, so the model
// cache silently no-ops (that path is intentional).
// Run: pnpm tsx tests/ocr-download.ts

import { strict as assert } from "node:assert";
import {
  downloadFiles,
  type OcrModelFileSpec,
  type OcrModelFiles,
} from "../src/core/ocr/download.ts";

const MB = 1024 * 1024;
const SIZES: Record<keyof OcrModelFiles, number> = {
  detector: 20 * MB,
  encoder: 9 * MB,
  decoder: 3 * MB,
  vocab: 24 * 1024,
};
const SPECS: Record<keyof OcrModelFiles, OcrModelFileSpec> = Object.fromEntries(
  Object.entries(SIZES).map(([key, size]) => [
    key,
    { url: `https://models.test/${key}.onnx`, size },
  ]),
) as Record<keyof OcrModelFiles, OcrModelFileSpec>;
const GRAND_TOTAL = Object.values(SIZES).reduce((sum, n) => sum + n, 0);

// --- mock network -----------------------------------------------------------

const byteAt = (i: number) => i % 251;

interface MockFile {
  size: number;
  ignoreRange?: boolean; // answer 200 to ranged GETs
  dropGet?: number; // kill this GET ordinal mid-stream
  shortStream?: boolean; // close every stream at 60% (middlebox truncation)
  dead?: boolean; // every request network-errors
  // filled by the mock:
  getCount: number;
  resumed: boolean;
}

function bodyStream(
  start: number,
  length: number,
  behavior?: "drop" | "short",
): ReadableStream<Uint8Array> {
  let sent = 0;
  const limit =
    behavior === "drop"
      ? Math.max(1, Math.floor(length / 3))
      : behavior === "short"
        ? Math.max(1, Math.floor(length * 0.6))
        : length;
  return new ReadableStream({
    pull(controller) {
      if (sent >= limit) {
        if (behavior === "drop") controller.error(new Error("socket hangup"));
        else controller.close();
        return;
      }
      const n = Math.min(65536, limit - sent);
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
    files.set(SPECS[key as keyof OcrModelFiles].url, {
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
    if ((init?.method ?? "GET") !== "GET") {
      throw new TypeError(`unexpected ${init?.method} request: ${url}`);
    }
    file.getCount += 1;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.Range ?? "");
    const behavior = file.dropGet === file.getCount ? "drop" : file.shortStream ? "short" : undefined;
    if (!range || file.ignoreRange) {
      if (range && file.ignoreRange) file.resumed = true;
      return new Response(bodyStream(0, file.size, behavior), { status: 200 });
    }
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : file.size - 1;
    if (start >= file.size || start > end) {
      return new Response(null, { status: 416 });
    }
    if (start > 0) file.resumed = true;
    const length = Math.min(end, file.size - 1) - start + 1;
    return new Response(bodyStream(start, length, behavior), {
      status: 206,
      headers: {
        "content-range": `bytes ${start}-${start + length - 1}/${file.size}`,
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

function progressNeverOvershoots(emissions: Emission[]): boolean {
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

await scenario("healthy network", async () => {
  mockNetwork({
    detector: { size: SIZES.detector } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(SPECS, w.onProgress);
  check(w.emissions.length > 10, "progress streams in many steps");
  check(progressNeverOvershoots(w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(bytesMatch("healthy", files), "bytes assemble correctly (ranged + whole)");
});

await scenario("chunked responses (no Content-Length — sizes still known)", async () => {
  // Totals come from the hardcoded specs, so a server that hides
  // Content-Length changes nothing for the bar.
  mockNetwork({
    detector: { size: SIZES.detector } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const files = await downloadFiles(SPECS, w.onProgress);
  check(progressNeverOvershoots(w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(bytesMatch("chunked", files), "bytes assemble correctly");
});

await scenario("dropped streams resume and retry", async () => {
  const files = mockNetwork({
    detector: { size: SIZES.detector, dropGet: 1 } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder, dropGet: 1 } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const w = watch();
  const result = await downloadFiles(SPECS, w.onProgress);
  check(progressNeverOvershoots(w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(
    files.get(SPECS.detector.url)!.resumed,
    "ranged part resumes from received bytes",
  );
  check(
    files.get(SPECS.decoder.url)!.resumed,
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
  const files = await downloadFiles(SPECS, w.onProgress);
  check(progressNeverOvershoots(w.emissions), "never exceeds 100%");
  check(landsExactlyAt100(w.emissions), "lands at exactly 100%");
  check(bytesMatch("ignoreRange", files), "whole-file fallback downloads right");
});

await scenario("truncated responses reject (middlebox poison)", async () => {
  mockNetwork({
    detector: { size: SIZES.detector } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder, shortStream: true } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const failure = await downloadFiles(SPECS, () => {}).then(
    () => null,
    (err: unknown) => err,
  );
  check(failure instanceof Error, "truncated download rejects, never cached");
});

await scenario("dead network rejects, bounded attempts", async () => {
  mockNetwork({
    detector: { size: SIZES.detector, dead: true } as MockFile,
    encoder: { size: SIZES.encoder } as MockFile,
    decoder: { size: SIZES.decoder } as MockFile,
    vocab: { size: SIZES.vocab } as MockFile,
  });
  const started = Date.now();
  const failure = await downloadFiles(SPECS, () => {}).then(
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
