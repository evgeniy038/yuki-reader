import { loadOcrModel, putOcrModel } from "../storage";
import type { OcrEp } from "./ort-runtime";

// OCR model downloads. Every file is SAME-ORIGIN — shipped in the repo
// under /ocr-models and served by the same host as the app: Hugging Face,
// where the weights come from originally, is unreachable without a VPN in
// some regions, so the app now carries its own copies. The two files that
// never existed on HF stay as they were: the KV-cache merged decoder
// (~30MB, exported in-house with a dynamic batch dim — one run advances a
// whole crop batch in lockstep; ~2.6x faster greedy decode at identical CER
// vs full-prefix) and the fp16 detector (~85MB, converted in-house from
// ogkalu's fp32 export).
//
// Weights choice follows the execution provider (see detectPreferredEp):
//   encoder:  wasm   → int8 (MatMulInteger: the CPU int8 GEMM is fastest)
//             webgpu → q4f16 (MatMulNBits: the ONLY quantization with a
//                      native GPU kernel — measured ~12x faster than the
//                      int8 encoder on wasm, while int8/fp16 on webgpu are
//                      SLOWER than wasm, gpuweb#5292)
//   detector: wasm   → int8 43MB (~1.3s/page, CPU-bound; threads don't
//                      help — memory-bandwidth-bound, measured)
//             webgpu → fp16 85MB (~68ms/page, 19x faster — measured; int8
//                      on webgpu falls back to CPU kernels and is 2.7x
//                      SLOWER than wasm)
//
// Hosting our own files means their sizes are KNOWN — hardcoded below.
// That buys three things: the progress bar gets honest totals from byte
// zero, no HEAD probe is needed (fewer round-trips before bytes flow), and
// a poisoned cache entry (an interrupted or middleboxed download once saved
// as a model) heals itself — anything the wrong size is re-downloaded, and
// a fresh download that arrives the wrong size is never cached. Files are
// downloaded ONCE — big ones over parallel HTTP ranges (six streams cut the
// wait several-fold on throttled per-connection links) — and kept in
// IndexedDB forever after. Broken transfers resume from the bytes already
// received (HTTP Range) and retry a few times before the download is
// declared failed.
//
// Sizes are in BYTES of the exact files in public/ocr-models — update them
// when a model is re-exported.
const FILES = {
  detectorWasm: { path: "ocr-models/detector_int8.onnx", size: 43838857 },
  detectorWebgpu: { path: "ocr-models/detector_fp16.onnx", size: 84724335 },
  encoderWasm: { path: "ocr-models/encoder_quantized.onnx", size: 86967767 },
  encoderWebgpu: { path: "ocr-models/encoder_q4f16.onnx", size: 49758716 },
  decoder: {
    path: "ocr-models/decoder_model_merged_batch_int8.onnx",
    size: 29687365,
  },
  vocab: { path: "ocr-models/vocab.txt", size: 24072 },
} as const;

export interface OcrModelFiles {
  detector: Uint8Array;
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: Uint8Array;
}

/** A file the app downloads: where from and how big it must arrive. */
export interface OcrModelFileSpec {
  url: string;
  size: number;
}

/** Model URLs per execution provider. Needs BASE_URL, so it stays a
    function: evaluated only from downloadModelFiles, it keeps the module
    importable outside Vite (node tests drive downloadFiles). */
function specsFor(ep: OcrEp): Record<keyof OcrModelFiles, OcrModelFileSpec> {
  const base = import.meta.env.BASE_URL;
  const pick = ep === "webgpu" ? "Webgpu" : "Wasm";
  return {
    detector: {
      url: `${base}${FILES[`detector${pick}`].path}`,
      size: FILES[`detector${pick}`].size,
    },
    encoder: {
      url: `${base}${FILES[`encoder${pick}`].path}`,
      size: FILES[`encoder${pick}`].size,
    },
    decoder: {
      url: `${base}${FILES.decoder.path}`,
      size: FILES.decoder.size,
    },
    vocab: { url: `${base}${FILES.vocab.path}`, size: FILES.vocab.size },
  };
}

/** Files smaller than this gain nothing from parallel ranges. */
const RANGE_MIN_SIZE = 8 * 1024 * 1024;
const RANGE_STREAMS = 6;
/** Retries per transfer attempt before the download is declared failed. */
const ATTEMPTS = 4;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const asError = (err: unknown): Error =>
  err instanceof Error ? err : new Error(String(err));

/** The server answered a ranged GET with a plain 200 — ranges unsupported. */
class RangeUnsupportedError extends Error {}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** Whole file as one stream. A retry asks for only the remaining bytes, so
    a dropped tunnel costs the fetched prefix solely when the server ignores
    ranges and restarts the body from byte 0. */
async function fetchWhole(
  url: string,
  total: number,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let loaded = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(
        url,
        loaded > 0 ? { headers: { Range: `bytes=${loaded}-` } } : undefined,
      );
      if (response.status === 200 && loaded > 0) {
        chunks = [];
        loaded = 0;
      } else if (!response.ok && response.status !== 206) {
        throw new Error(`OCR model download failed (${response.status})`);
      }
      if (!response.body) {
        throw new Error("OCR model download failed (empty body)");
      }
      onBytes(loaded, total);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onBytes(Math.min(loaded, total), total);
      }
      if (loaded !== total) {
        throw new Error("OCR model download truncated");
      }
      return concat(chunks, loaded);
    } catch (err) {
      if (attempt >= ATTEMPTS) throw asError(err);
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
}

/** One byte range of a file; a retry continues from the bytes already
    received instead of starting the part over. */
async function fetchPart(
  url: string,
  start: number,
  end: number,
  onLoaded: (loaded: number) => void,
): Promise<Uint8Array> {
  const expected = end - start + 1;
  let chunks: Uint8Array[] = [];
  let received = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start + received}-${end}` },
      });
      if (response.status === 200) throw new RangeUnsupportedError();
      if (response.status !== 206 || !response.body) {
        throw new Error(`OCR model range download failed (${response.status})`);
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // A misbehaving server may over-deliver: keep only the range.
        const keep = Math.min(value.length, expected - received);
        chunks.push(value.subarray(0, keep));
        received += keep;
        onLoaded(received);
        if (received >= expected) {
          await reader.cancel();
          break;
        }
      }
      if (received < expected) throw new Error("OCR model range short read");
      return concat(chunks, expected);
    } catch (err) {
      if (err instanceof RangeUnsupportedError) throw err;
      if (attempt >= ATTEMPTS) throw asError(err);
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
}

/** One file over N parallel HTTP ranges; a server that won't do ranges gets
    the plain whole-file stream instead. */
async function fetchRanged(
  url: string,
  total: number,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  if (total < RANGE_MIN_SIZE) return fetchWhole(url, total, onBytes);
  const streams = Math.min(
    RANGE_STREAMS,
    Math.ceil(total / RANGE_MIN_SIZE) + 1,
  );
  const partSize = Math.ceil(total / streams);
  const loaded = new Array<number>(streams).fill(0);
  try {
    const parts = await Promise.all(
      Array.from({ length: streams }, (_, i) =>
        fetchPart(
          url,
          i * partSize,
          Math.min(total, (i + 1) * partSize) - 1,
          (n) => {
            loaded[i] = n;
            onBytes(
              loaded.reduce((sum, part) => sum + part, 0),
              total,
            );
          },
        ),
      ),
    );
    return concat(parts, total);
  } catch (err) {
    if (err instanceof RangeUnsupportedError) {
      return fetchWhole(url, total, onBytes);
    }
    throw err;
  }
}

/** One file (or the cached copy), reporting bytes against its known size. */
async function modelBytes(
  spec: OcrModelFileSpec,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  // Cache access is best-effort: without IndexedDB the download still works,
  // it just repeats next session. A wrong-size entry is poison, not a hit.
  const cached = await loadOcrModel(spec.url).catch(() => undefined);
  if (cached && cached.length === spec.size) {
    onBytes(spec.size, spec.size);
    return cached;
  }
  const bytes = await fetchRanged(spec.url, spec.size, onBytes);
  if (bytes.length !== spec.size) {
    throw new Error(`OCR model corrupted (${spec.url})`);
  }
  void putOcrModel(spec.url, bytes).catch(() => {});
  return bytes;
}

/** Download (once) every OCR model file. Main thread only — workers receive
    the bytes over postMessage. */
export async function downloadModelFiles(
  ep: OcrEp,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelFiles> {
  return downloadFiles(specsFor(ep), onProgress);
}

/** Download every file in `specs`, reporting aggregate progress. Totals are
    the known file sizes, so loaded never exceeds total. */
export async function downloadFiles(
  specs: Record<keyof OcrModelFiles, OcrModelFileSpec>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelFiles> {
  const progress = new Map<string, { loaded: number; total: number }>();
  const report = (url: string) => (loaded: number, total: number) => {
    progress.set(
      url,
      total > 0 ? { loaded: Math.min(loaded, total), total } : { loaded: 0, total: 0 },
    );
    if (!onProgress) return;
    let allLoaded = 0;
    let allTotal = 0;
    for (const { loaded: l, total: t } of progress.values()) {
      allLoaded += l;
      allTotal += t;
    }
    onProgress(allLoaded, allTotal);
  };

  const [detector, encoder, decoder, vocab] = await Promise.all([
    modelBytes(specs.detector, report(specs.detector.url)),
    modelBytes(specs.encoder, report(specs.encoder.url)),
    modelBytes(specs.decoder, report(specs.decoder.url)),
    modelBytes(specs.vocab, report(specs.vocab.url)),
  ]);
  return { detector, encoder, decoder, vocab };
}
