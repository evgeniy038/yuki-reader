import { loadOcrModel, putOcrModel } from "../storage";
import type { OcrEp } from "./ort-runtime";

// OCR model downloads. The recognition encoder comes in two weights builds
// and the vocab from Hugging Face, plus two same-origin files from
// /ocr-models that do not exist on HF: the KV-cache merged decoder (~30MB,
// exported in-house with a dynamic batch dim — one run advances a whole crop
// batch in lockstep; ~2.6x faster greedy decode at identical CER vs
// full-prefix) and the fp16 detector (~85MB, converted in-house from
// ogkalu's fp32 export). The HF CDN is CORS-enabled and — measured — faster
// than GitHub release assets, which also send no CORS headers so a browser
// cannot fetch them anyway.
//
// Weights choice follows the execution provider (see detectPreferredEp):
//   encoder:  wasm   → int8 (MatMulInteger: the CPU int8 GEMM is fastest)
//             webgpu → q4f16 (MatMulNBits: the ONLY quantization with a
//                      native GPU kernel — measured ~12x faster than the
//                      int8 encoder on wasm, while int8/fp16 on webgpu are
//                      SLOWER than wasm, gpuweb#5292)
//   detector: wasm   → int8 43MB from HF (~1.3s/page, CPU-bound; threads
//                      don't help — memory-bandwidth-bound, measured)
//             webgpu → fp16 85MB same-origin (~68ms/page, 19x faster —
//                      measured; int8 on webgpu falls back to CPU kernels
//                      and is 2.7x SLOWER than wasm)
// Files are downloaded ONCE — big ones over parallel HTTP ranges (the CDN
// throttles per-connection, six streams cut the wait several-fold on slow
// links) — and cached in IndexedDB forever after.
//
// The network is not trusted. A VPN or proxy may strip Content-Length
// (chunked responses), a tunnel may drop mid-stream. So a file's total may
// stay UNKNOWN (0) for the whole transfer, and the aggregate progress only
// sums files with a known total, each clamped at its own size — the percent
// can pause but never exceed 100, and a finished file reports its exact
// length so the bar lands at precisely 100%. Broken transfers resume from
// the bytes already received (HTTP Range) and retry a few times before the
// download is declared failed.
const HF = "https://huggingface.co";

/** Model URLs per execution provider. Same-origin paths need BASE_URL, so
    this stays a function: evaluated only from downloadModelFiles, it keeps
    the module importable outside Vite (node tests drive downloadFiles). */
function fileUrlsFor(ep: OcrEp): Record<keyof OcrModelFiles, string> {
  const base = import.meta.env.BASE_URL;
  return {
    // The full detector, not the 11MB "-s" one: measured CER is twice as
    // good (0.077 vs 0.157 on kaguya golden).
    detector:
      ep === "webgpu"
        ? `${base}ocr-models/detector_fp16.onnx`
        : `${HF}/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx`,
    encoder:
      ep === "webgpu"
        ? `${HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_q4f16.onnx`
        : `${HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_quantized.onnx`,
    decoder: `${base}ocr-models/decoder_model_merged_batch_int8.onnx`,
    vocab: `${HF}/kha-white/manga-ocr-base/resolve/main/vocab.txt`,
  };
}

export interface OcrModelFiles {
  detector: Uint8Array;
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: Uint8Array;
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
    ranges and restarts the body from byte 0. `total` may stay 0 when the
    server never reveals the size. */
async function fetchWhole(
  url: string,
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
      const length = Number(response.headers.get("content-length") ?? 0);
      const total = response.status === 206 ? loaded + length : length;
      onBytes(loaded, total);
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onBytes(loaded, total);
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
      if (attempt >= ATTEMPTS) throw asError(err);
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
}

/** One file over N parallel HTTP ranges; a server that won't do ranges gets
    the plain whole-file stream instead. */
async function fetchRanged(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  let total = 0;
  let finalUrl = url;
  let ranged = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const head = await fetch(url, { method: "HEAD" });
      if (head.ok) {
        total = Number(head.headers.get("content-length") ?? 0);
        finalUrl = head.url || url;
        if (total >= RANGE_MIN_SIZE) {
          // Probe once: some CDNs answer plain 200 to ranged GETs.
          const probe = await fetch(finalUrl, {
            headers: { Range: "bytes=0-0" },
          });
          await probe.body?.cancel();
          ranged = probe.status === 206;
        }
      }
      break;
    } catch (err) {
      if (attempt >= ATTEMPTS) throw asError(err);
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
  if (!ranged) return fetchWhole(url, onBytes);
  const streams = Math.min(
    RANGE_STREAMS,
    Math.ceil(total / RANGE_MIN_SIZE) + 1,
  );
  const partSize = Math.ceil(total / streams);
  const loaded = new Array<number>(streams).fill(0);
  const parts = await Promise.all(
    Array.from({ length: streams }, (_, i) =>
      fetchPart(
        finalUrl,
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
}

/** One file (or the cached copy), reporting bytes against its real size. */
async function modelBytes(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  // Cache access is best-effort: without IndexedDB the download still works,
  // it just repeats next session.
  const cached = await loadOcrModel(url).catch(() => undefined);
  if (cached) {
    onBytes(cached.length, cached.length);
    return cached;
  }
  const bytes = await fetchRanged(url, onBytes);
  // The exact size is known now even when the server never revealed it.
  onBytes(bytes.length, bytes.length);
  void putOcrModel(url, bytes).catch(() => {});
  return bytes;
}

/** Download (once) every OCR model file. Main thread only — workers receive
    the bytes over postMessage. */
export async function downloadModelFiles(
  ep: OcrEp,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelFiles> {
  return downloadFiles(fileUrlsFor(ep), onProgress);
}

/** Download every file in `urls`, reporting aggregate progress. Files with a
    server-hidden size sit the ratio out until they finish, so loaded never
    exceeds total. */
export async function downloadFiles(
  urls: Record<keyof OcrModelFiles, string>,
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
    modelBytes(urls.detector, report(urls.detector)),
    modelBytes(urls.encoder, report(urls.encoder)),
    modelBytes(urls.decoder, report(urls.decoder)),
    modelBytes(urls.vocab, report(urls.vocab)),
  ]);
  return { detector, encoder, decoder, vocab };
}
