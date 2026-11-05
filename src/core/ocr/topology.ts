import type { OcrEp } from "./ort-runtime";

/** What the OCR pool size depends on — read from the browser by pool.ts. */
export interface OcrHost {
  ep: OcrEp;
  /** navigator.hardwareConcurrency (WebKit reports at most 2–4 on iOS). */
  cores: number;
  /** Cross-origin isolated: wasm threads need SharedArrayBuffer. */
  isolated: boolean;
  /** The primary pointer is a finger: a phone or a tablet. */
  touch: boolean;
  /** `?ocrPool=N` / `?ocrThreads=M` probes; NaN or < 1 means unset. */
  poolOverride?: number;
  threadsOverride?: number;
}

/** Pool/threads topology, decided once the execution provider is known
    (pool.ts spawns the workers). `?ocrPool=N` / `?ocrThreads=M` override
    for probes. Every worker holds its own models and the detector's working
    set, so the pool size is a memory decision as much as a speed one:
      touch (phones, tablets) — ONE worker, whatever the EP. iOS kills a page
        past roughly 2 GB and charges it for its GPU memory too. Measured on
        the 281-page volume that crash-looped an iPhone (Chrome, page + GPU
        process): 2 workers 2.5–3.5 GB, back to 2.7 GB within 6 s of the
        restart after each kill; 1 worker ≈ 1.5 GB.
      wasm EP, isolated — ONE worker with half the cores as wasm threads
        (P-cores). int8 GEMM is memory-bandwidth-bound, so extra workers only
        fight over the bus (measured on an M3 Pro, kaguya vol 1: single-thread
        ~830ms/block; 1×4 ~210; 1×6 ~148 ← sweet spot; 2×3 ~300, same
        throughput at 2× the memory; 1×8 ~255, E-cores stall the barriers).
      webgpu EP — a small POOL of workers, isolated or not. The detector and
        encoder run on the GPU and only the decoder is CPU, so separate
        workers overlap one page's CPU decode with the next page's GPU work.
        Measured on a 12-core M3 Pro, kny vol 1, BYTE-IDENTICAL output at
        every pool size. The initial sweep reached 1×6 ≈ 150, 2×3 ≈ 230,
        3×2 ≈ 248, 4×1 ≈ 277 pages/min; after detector reuse + selective
        decoder fetch: 4×1 ≈ 356, 5×1 ≈ 423, 6×1 ≈ 380. Five workers win on
        12+ cores; the sixth loses to contention. Threads stay at 1 — the GPU
        carries the encoder/detector and workers already parallelize the
        GEMM-bound decoder. Each worker is its OWN runtime instance with strictly
        serialized runs, so one runtime never runs two sessions at once —
        but a pool can still crash, which is exactly what the dead-worker
        replacement in pool.ts is for.
      not isolated, wasm — no SharedArrayBuffer → one thread; a small pool of
        single-threaded workers is the fallback (3 on 8+ cores, else 2). */
export function ocrTopology(host: OcrHost): { pool: number; threads: number } {
  const { ep, cores, isolated, touch } = host;
  const poolOverride = host.poolOverride ?? Number.NaN;
  const threadsOverride = host.threadsOverride ?? Number.NaN;
  const pool =
    Number.isFinite(poolOverride) && poolOverride >= 1
      ? Math.min(6, Math.floor(poolOverride))
      : touch
        ? 1
        : ep === "webgpu"
          ? cores >= 12
            ? 5
            : Math.min(4, Math.max(2, Math.floor(cores / 3)))
          : isolated
            ? 1
            : cores >= 8
              ? 3
              : 2;
  const threads =
    Number.isFinite(threadsOverride) && threadsOverride >= 1
      ? Math.min(8, Math.floor(threadsOverride))
      : ep === "webgpu"
        ? 1
        : isolated
          ? Math.min(8, Math.max(1, Math.floor(cores / 2)))
          : 1;
  return { pool, threads };
}
