import { hasOcrModel, loadOcrModel, putOcrModel } from "../storage";
import { modelParts, partRange, partUrl } from "./model-parts";
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
// declared failed. A model above the host's file cap is served in parts
// (model-parts.ts): those come down in parallel and are joined here.
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
    function: evaluated only from cacheModelFiles, it keeps the module
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
  const bytes = await fetchModel(spec, onBytes);
  void putOcrModel(spec.url, bytes).catch(() => {});
  return bytes;
}

/** A model the host serves in parts: every part at once, joined in order. */
async function fetchSplit(
  url: string,
  total: number,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const count = modelParts(total);
  const loaded = new Array<number>(count).fill(0);
  const parts = await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const { start, end } = partRange(total, i);
      return fetchWhole(partUrl(url, i), end - start, (n) => {
        loaded[i] = n;
        onBytes(loaded.reduce((sum, part) => sum + part, 0), total);
      });
    }),
  );
  return concat(parts, total);
}

async function fetchModel(
  spec: OcrModelFileSpec,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const bytes =
    modelParts(spec.size) > 1
      ? await fetchSplit(spec.url, spec.size, onBytes)
      : await fetchRanged(spec.url, spec.size, onBytes);
  if (bytes.length !== spec.size) {
    throw new Error(`OCR model corrupted (${spec.url})`);
  }
  return bytes;
}

/** How a worker gets one model file: from the cache under `url` — or, when
    the cache refused the write (quota, private mode), the bytes themselves. */
export interface OcrModelRef extends OcrModelFileSpec {
  bytes?: Uint8Array;
}

export type OcrModelRefs = Record<keyof OcrModelFiles, OcrModelRef>;

/** Main thread: make sure every model file for `ep` sits in the cache —
    downloaded once, with progress — WITHOUT keeping the bytes. Each worker
    then reads its own copy (readModelFiles): the main thread never holds
    the ~165MB, never structured-clones it per worker (a ~0.5s freeze with
    five workers), and a crash replacement needs nothing but the refs. */
export async function cacheModelFiles(
  ep: OcrEp,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelRefs> {
  return eachFile(specsFor(ep), onProgress, async (spec, onBytes) => {
    if (await hasOcrModel(spec.url).catch(() => false)) {
      onBytes(spec.size, spec.size);
      return spec;
    }
    const bytes = await fetchModel(spec, onBytes);
    try {
      await putOcrModel(spec.url, bytes);
      return spec;
    } catch {
      return { ...spec, bytes };
    }
  });
}

/** Worker: the model bytes behind the refs — handed over, cached, or (a
    poisoned/evicted cache entry) fetched again and re-cached. */
export async function readModelFiles(refs: OcrModelRefs): Promise<OcrModelFiles> {
  return eachFile(refs, undefined, (ref, onBytes) =>
    ref.bytes ? Promise.resolve(ref.bytes) : modelBytes(ref, onBytes),
  );
}

/** Download every file in `specs` (cache first), reporting aggregate
    progress. Totals are the known file sizes, so loaded never exceeds
    total. */
export async function downloadFiles(
  specs: Record<keyof OcrModelFiles, OcrModelFileSpec>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelFiles> {
  return eachFile(specs, onProgress, modelBytes);
}

/** Run `perFile` over all four model files in parallel with one aggregate
    progress callback. */
async function eachFile<S extends OcrModelFileSpec, T>(
  specs: Record<keyof OcrModelFiles, S>,
  onProgress: ((loaded: number, total: number) => void) | undefined,
  perFile: (spec: S, onBytes: (loaded: number, total: number) => void) => Promise<T>,
): Promise<Record<keyof OcrModelFiles, T>> {
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
    perFile(specs.detector, report(specs.detector.url)),
    perFile(specs.encoder, report(specs.encoder.url)),
    perFile(specs.decoder, report(specs.decoder.url)),
    perFile(specs.vocab, report(specs.vocab.url)),
  ]);
  return { detector, encoder, decoder, vocab };
}
