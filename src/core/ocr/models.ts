import {
  initOrtRuntime,
  type InferenceSession,
  type OcrEp,
} from "./ort-runtime";
import { downloadModelFiles, type OcrModelFiles } from "./download";

// OCR models: download (see download.ts) → inference sessions (here). The
// bytes are handed to the worker pool, which builds its own sessions from
// them (workers can't share memory, so each keeps a copy — the price of
// parallel pages). Sessions also parallelize WITHIN a page via wasm threads,
// but only where the app is cross-origin isolated (COOP/COEP headers);
// elsewhere they fall back to one thread.
export { downloadModelFiles, type OcrModelFiles };

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

export interface OcrModels {
  detector: InferenceSession;
  encoder: InferenceSession;
  decoder: InferenceSession;
  vocab: string[];
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
