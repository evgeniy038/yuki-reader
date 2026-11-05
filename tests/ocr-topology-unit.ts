// Node unit test for the OCR pool size (src/core/ocr/topology.ts). The
// regression: an iPhone ran TWO OCR workers (WebKit reports 2–4 cores, the
// WebGPU rule floors the pool at 2), each with its own models — 2.5–3.5 GB
// on the 281-page volume that crash-looped the phone at every start. Phones
// and tablets get one worker; desktops keep their measured pools.
// Run: pnpm tsx tests/ocr-topology-unit.ts

import { strict as assert } from "node:assert";
import { ocrTopology, type OcrHost } from "../src/core/ocr/topology.ts";

const phone: OcrHost = { ep: "webgpu", cores: 4, isolated: false, touch: true };

// Phones and tablets: one worker, whatever the EP, cores or isolation.
for (const host of [
  phone,
  { ...phone, cores: 2 },
  { ...phone, ep: "wasm" },
  { ...phone, ep: "wasm", cores: 8 },
  { ...phone, cores: 12, isolated: true },
] satisfies OcrHost[]) {
  assert.equal(ocrTopology(host).pool, 1, JSON.stringify(host));
}
// Threads follow the EP as before: none on WebGPU, half the cores on an
// isolated wasm page.
assert.deepEqual(ocrTopology(phone), { pool: 1, threads: 1 });
assert.deepEqual(ocrTopology({ ...phone, ep: "wasm", cores: 8, isolated: true }), { pool: 1, threads: 4 });

// Desktops keep the measured topology.
const desktop: OcrHost = { ep: "webgpu", cores: 12, isolated: false, touch: false };
assert.deepEqual(ocrTopology(desktop), { pool: 5, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, cores: 8 }), { pool: 2, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, cores: 4 }), { pool: 2, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, cores: 16 }), { pool: 5, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, ep: "wasm", isolated: true }), { pool: 1, threads: 6 });
assert.deepEqual(ocrTopology({ ...desktop, ep: "wasm", cores: 20, isolated: true }), { pool: 1, threads: 8 });
assert.deepEqual(ocrTopology({ ...desktop, ep: "wasm", cores: 8 }), { pool: 3, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, ep: "wasm", cores: 4 }), { pool: 2, threads: 1 });

// Probe overrides win everywhere, clamped; NaN / < 1 means unset.
assert.deepEqual(ocrTopology({ ...phone, poolOverride: 2 }), { pool: 2, threads: 1 });
assert.deepEqual(ocrTopology({ ...desktop, poolOverride: 9, threadsOverride: 12 }), { pool: 6, threads: 8 });
assert.deepEqual(ocrTopology({ ...desktop, poolOverride: Number.NaN, threadsOverride: 0 }), { pool: 5, threads: 1 });
assert.deepEqual(ocrTopology({ ...phone, poolOverride: 0.5 }), { pool: 1, threads: 1 });

console.log("ocr topology: ok");
