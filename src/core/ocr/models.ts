import {
  initOrtRuntime,
  type InferenceSession,
  type OcrEp,
} from "./ort-runtime";
import { loadOcrModel, putOcrModel } from "../storage";

// OCR model files: the recognition encoder in two weights builds and the
// vocab from Hugging Face, plus two same-origin files from /ocr-models that
// do not exist on HF: the KV-cache merged decoder (~30MB, exported in-house
// with a dynamic batch dim — one run advances a whole crop batch in
// lockstep; ~2.6x faster greedy decode at identical CER vs full-prefix) and
// the fp16 detector (~85MB, converted in-house from ogkalu's fp32 export).
// The HF CDN is CORS-enabled and — measured — faster than GitHub release
// assets, which also send no CORS headers so a browser cannot fetch them
// anyway.
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
// Files are downloaded ONCE in the main thread — big ones over parallel HTTP
// ranges (the CDN throttles per-connection, six streams cut the wait
// several-fold on slow links) — and cached in IndexedDB forever after. The
// bytes are then handed to the worker pool, which builds its own inference
// sessions from them (workers can't share memory, so each keeps a copy — the
// price of parallel pages). Sessions also parallelize WITHIN a page via wasm
// threads, but only where the app is cross-origin isolated (COOP/COEP
// headers); elsewhere they fall back to one thread.
const HF = "https://huggingface.co";
const FILES = {
  // The full detector, not the 11MB "-s" one: measured CER is twice as good
  // (0.077 vs 0.157 on kaguya golden).
  detectorWasm: `${HF}/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx`,
  detectorWebgpu: `${import.meta.env.BASE_URL}ocr-models/detector_fp16.onnx`,
  encoderWasm: `${HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_quantized.onnx`,
  encoderWebgpu: `${HF}/onnx-community/manga-ocr-base-ONNX/resolve/main/onnx/encoder_model_q4f16.onnx`,
  decoder: `${import.meta.env.BASE_URL}ocr-models/decoder_model_merged_batch_int8.onnx`,
  vocab: `${HF}/kha-white/manga-ocr-base/resolve/main/vocab.txt`,
} as const;

const EP_STORAGE_KEY = "yuki-ocr-ep";

/** wasm or webgpu, decided once per device: WebGPU needs no probing beyond
    adapter presence when the encoder weights are GPU-native (q4f16) — the
    slow-path anomalies of fp16/int8 on WebGPU do not apply. The choice is
    cached in localStorage; a session-build failure still falls back to the
    wasm EP at runtime (see createOcrSessions). */
export async function detectPreferredEp(): Promise<OcrEp> {
  try {
    const cached = localStorage.getItem(EP_STORAGE_KEY);
    if (cached === "wasm" || cached === "webgpu") return cached;
  } catch {
    // storage unavailable — decide fresh
  }
  let ep: OcrEp = "wasm";
  try {
    const gpu = (
      navigator as Navigator & {
        gpu?: { requestAdapter(): Promise<unknown> };
      }
    ).gpu;
    if (gpu && (await gpu.requestAdapter())) ep = "webgpu";
  } catch {
    ep = "wasm";
  }
  try {
    localStorage.setItem(EP_STORAGE_KEY, ep);
  } catch {
    // storage unavailable — fine, we just re-detect next session
  }
  return ep;
}

/** Files smaller than this gain nothing from parallel ranges. */
const RANGE_MIN_SIZE = 8 * 1024 * 1024;
const RANGE_STREAMS = 6;

export interface OcrModelFiles {
  detector: Uint8Array;
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: Uint8Array;
}

export interface OcrModels {
  detector: InferenceSession;
  encoder: InferenceSession;
  decoder: InferenceSession;
  vocab: string[];
}

async function fetchWhole(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`OCR model download failed (${response.status})`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onBytes(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** One file over N parallel HTTP ranges; falls back to a plain stream when
    the server won't play along. */
async function fetchRanged(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const head = await fetch(url, { method: "HEAD" });
  const total = head.ok ? Number(head.headers.get("content-length") ?? 0) : 0;
  if (total < RANGE_MIN_SIZE) return fetchWhole(url, onBytes);
  const finalUrl = head.url || url;
  const streams = Math.min(
    RANGE_STREAMS,
    Math.ceil(total / RANGE_MIN_SIZE) + 1,
  );
  const partSize = Math.ceil(total / streams);
  const loaded = new Array<number>(streams).fill(0);
  const report = () => onBytes(loaded.reduce((a, b) => a + b, 0), total);
  try {
    const parts = await Promise.all(
      Array.from({ length: streams }, async (_, i) => {
        const start = i * partSize;
        const end = Math.min(total, start + partSize) - 1;
        const response = await fetch(finalUrl, {
          headers: { Range: `bytes=${start}-${end}` },
        });
        if (response.status !== 206 || !response.body) {
          throw new Error("range fetch unsupported");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded[i] = loaded[i]! + value.length;
          report();
        }
        const part = new Uint8Array(loaded[i]!);
        let offset = 0;
        for (const chunk of chunks) {
          part.set(chunk, offset);
          offset += chunk.length;
        }
        return part;
      }),
    );
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  } catch {
    return fetchWhole(url, onBytes);
  }
}

/** Fetch one file (or reuse the cached copy), reporting aggregate progress. */
async function modelBytes(
  url: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const cached = await loadOcrModel(url);
  if (cached) {
    onBytes(cached.length, cached.length);
    return cached;
  }
  const bytes = await fetchRanged(url, onBytes);
  void putOcrModel(url, bytes);
  return bytes;
}

/** Download (once) every OCR model file. `onProgress` gets aggregate bytes
    across all files; totals may be 0 until headers arrive. Main thread only —
    workers receive the bytes over postMessage. */
export async function downloadModelFiles(
  ep: OcrEp,
  onProgress?: (loaded: number, total: number) => void,
): Promise<OcrModelFiles> {
  const progress = new Map<string, { loaded: number; total: number }>();
  const report = (url: string) => (loaded: number, total: number) => {
    progress.set(url, { loaded, total });
    if (!onProgress) return;
    let allLoaded = 0;
    let allTotal = 0;
    for (const { loaded: l, total: t } of progress.values()) {
      allLoaded += l;
      allTotal += t;
    }
    onProgress(allLoaded, allTotal);
  };

  const encoderUrl = ep === "webgpu" ? FILES.encoderWebgpu : FILES.encoderWasm;
  const detectorUrl =
    ep === "webgpu" ? FILES.detectorWebgpu : FILES.detectorWasm;
  const [detector, encoder, decoder, vocab] = await Promise.all([
    modelBytes(detectorUrl, report(detectorUrl)),
    modelBytes(encoderUrl, report(encoderUrl)),
    modelBytes(FILES.decoder, report(FILES.decoder)),
    modelBytes(FILES.vocab, report(FILES.vocab)),
  ]);
  return { detector, encoder, decoder, vocab };
}

/** Build the inference sessions from model bytes. Runs inside a worker. The
    encoder and the detector go to WebGPU when the pool decided so (their
    weights are GPU-native: q4f16 MatMulNBits for the encoder, plain fp16
    for the detector); a session-build failure falls back to the wasm EP —
    both graphs run on CPU too, just slower. The decoder always stays on
    wasm: its merged int8 graph has no GPU kernels. */
export async function createOcrSessions(
  files: OcrModelFiles,
  threads = 1,
  ep: OcrEp = "wasm",
): Promise<OcrModels> {
  const rt = await initOrtRuntime(ep, threads);
  const wasmOnly = { executionProviders: ["wasm"] };
  const createGpuFirst = async (bytes: Uint8Array): Promise<InferenceSession> => {
    if (ep === "webgpu") {
      try {
        return await rt.InferenceSession.create(bytes, {
          executionProviders: ["webgpu"],
        });
      } catch (err) {
        console.warn("[ocr] webgpu session failed, falling back to wasm:", err);
      }
    }
    return rt.InferenceSession.create(bytes, wasmOnly);
  };
  // Sessions are created SEQUENTIALLY: onnxruntime-web rejects concurrent
  // creates outright ("another WebGPU EP inference session is being
  // created", "multiple calls to initWasm()"). One-time cost, ~2s total.
  const detector = await createGpuFirst(files.detector);
  const encoder = await createGpuFirst(files.encoder);
  const decoder = await rt.InferenceSession.create(files.decoder, wasmOnly);
  // id = line number; the file may end with a newline, so the real vocab
  // stride must come from the model's logits, never from this array.
  const vocab = new TextDecoder().decode(files.vocab).split("\n");
  return { detector, encoder, decoder, vocab };
}
