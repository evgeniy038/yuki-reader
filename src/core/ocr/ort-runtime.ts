import type * as OrtWasm from "onnxruntime-web/wasm";

// ONNX runtime facade. Two builds ship in onnxruntime-web: "wasm" (CPU) and
// "webgpu" (CPU + WebGPU via JSEP). The manga-ocr encoder runs ~12x faster
// on WebGPU — but only from the q4f16 weights (MatMulNBits has a native GPU
// kernel; int8 and fp16 do not, so those fall back to slower paths). Which
// build a worker uses is decided once at pool birth (see models.ts) and every
// session + tensor in that worker then comes from the SAME module instance —
// mixing Tensor objects across the two builds is not supported.
export type OcrEp = "wasm" | "webgpu";
export type Ort = typeof OrtWasm;
export type Tensor = OrtWasm.Tensor;
export type InferenceSession = OrtWasm.InferenceSession;

let runtime: Ort | null = null;

/** Load and configure the runtime for this worker; idempotent. */
export async function initOrtRuntime(ep: OcrEp, threads: number): Promise<Ort> {
  if (runtime) return runtime;
  const mod: Ort =
    ep === "webgpu"
      ? await import("onnxruntime-web/webgpu")
      : await import("onnxruntime-web/wasm");
  // Wasm threads need SharedArrayBuffer, which exists only under cross-origin
  // isolation. Anything above 1 without it is clamped by the runtime anyway,
  // but be explicit so the logs stay quiet.
  mod.env.wasm.numThreads = globalThis.crossOriginIsolated === true ? threads : 1;
  mod.env.logLevel = "warning";
  // The wasm binaries are static assets — Vite never touches them and the
  // PWA precaches them, so OCR works offline like everything else.
  mod.env.wasm.wasmPaths = `${import.meta.env.BASE_URL}ort/`;
  runtime = mod;
  return mod;
}

function getOrt(): Ort {
  if (!runtime) throw new Error("OCR runtime not initialized");
  return runtime;
}

/** Drop-in namespace for call sites shaped like `import * as ort from ...`:
    resolves every property against the lazily initialized runtime. */
export const ort: Ort = new Proxy({} as Ort, {
  get: (_target, prop: PropertyKey) =>
    (getOrt() as unknown as Record<PropertyKey, unknown>)[prop],
});
