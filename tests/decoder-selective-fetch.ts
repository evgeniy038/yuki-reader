// Selective-fetch decoder check: the shipped pipeline (src/core/ocr/
// pipeline.ts decodeBlocks) fetches only logits + the four decoder KV
// presents after step 0, reusing step 0's encoder KV. This runs BOTH
// strategies over the shipped merged decoder on deterministic random
// hidden states and asserts the greedy token arrays are EXACTLY equal.
// Timings are reported, never asserted. No manga fixture — just the model.
//   pnpm tsx tests/decoder-selective-fetch.ts

import { join } from "node:path";
import * as ort from "onnxruntime-node";

// Decode constants (MUST match src/core/ocr/pipeline.ts).
const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_TOKENS = 300;
const KV_LAYERS = 2;
const KV_HEADS = 12;
const KV_DIM = 64;
const MAX_SAME_RUN = 15;
const MAX_CYCLE_RUN = 12;
const RUN_KEEP = 3;

function runawayTruncateLen(ids: number[]): number | null {
  const n = ids.length;
  if (n < 2) return null;
  const last = ids[n - 1]!;
  let runStart = n - 1;
  while (runStart > 1 && ids[runStart - 1] === last) runStart--;
  if (n - runStart >= MAX_SAME_RUN) return runStart + RUN_KEEP;
  for (let k = 2; k <= 4; k++) {
    if (n - 1 < MAX_CYCLE_RUN) break;
    const tail = ids.slice(n - k).join();
    let reps = 1;
    while (
      n - (reps + 1) * k >= 1 &&
      ids.slice(n - (reps + 1) * k, n - reps * k).join() === tail
    ) {
      reps++;
    }
    if (reps * k >= MAX_CYCLE_RUN) return n - reps * k + k;
  }
  return null;
}

/** Deterministic PRNG so both strategies see byte-identical hidden. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHidden(rand: () => number, batch: number): ort.Tensor {
  const data = new Float32Array(batch * 197 * 768);
  for (let i = 0; i < data.length; i++) data[i] = (rand() * 2 - 1) * 0.1;
  return new ort.Tensor("float32", data, [batch, 197, 768]);
}

function emptyPast(batch: number): Record<string, ort.Tensor> {
  const past: Record<string, ort.Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32",
          new Float32Array(0),
          [batch, KV_HEADS, 0, KV_DIM],
        );
  return past;
}

/** Lockstep batched greedy decode (1:1 with pipeline.ts decodeBlocks).
    selective=false fetches every output every step (the OLD behavior);
    selective=true fetches logits + decoder presents after step 0 and
    disposes dead tensors as it goes (the NEW behavior). */
async function decode(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
  selective: boolean,
): Promise<{ ids: number[][]; ms: number }> {
  const batch = hidden.dims[0]!;
  const ids: number[][] = Array.from({ length: batch }, () => [START_TOKEN]);
  const done = new Array<boolean>(batch).fill(false);
  let remaining = batch;
  const past = emptyPast(batch);
  const laterFetch = [
    "logits",
    ...dec.outputNames.filter((name) => /^present\.\d+\.decoder\./.test(name)),
  ];
  let useBranch = false;
  const t0 = performance.now();
  try {
    for (let step = 0; step < MAX_TOKENS && remaining > 0; step++) {
      const tokens = new BigInt64Array(batch);
      for (let j = 0; j < batch; j++) {
        const row = ids[j]!;
        tokens[j] = BigInt(
          !useBranch ? START_TOKEN : done[j] ? EOS_TOKEN : row[row.length - 1]!,
        );
      }
      const inputIds = new ort.Tensor("int64", tokens, [batch, 1]);
      const mask = new ort.Tensor(
        "int64",
        new BigInt64Array(batch * (step + 1)).fill(1n),
        [batch, step + 1],
      );
      const branch = new ort.Tensor(
        "bool",
        new Uint8Array([useBranch ? 1 : 0]),
        [1],
      );
      const feeds: Record<string, ort.Tensor> = {
        input_ids: inputIds,
        encoder_hidden_states: hidden,
        attention_mask: mask,
        use_cache_branch: branch,
        ...past,
      };
      const decOut =
        selective && useBranch
          ? await dec.run(feeds, laterFetch)
          : await dec.run(feeds);
      if (selective) {
        inputIds.dispose();
        mask.dispose();
        branch.dispose();
      }
      for (const name of Object.keys(decOut)) {
        if (!name.startsWith("present.")) continue;
        const pastName = name.replace("present", "past_key_values");
        if (selective) past[pastName]!.dispose();
        past[pastName] = decOut[name]!;
      }
      const logits = decOut.logits!;
      const stride = logits.dims[2]!;
      const ldata = logits.data as Float32Array;
      for (let j = 0; j < batch; j++) {
        if (done[j]) continue;
        const row = ldata.subarray(j * stride, (j + 1) * stride);
        let best = 0;
        for (let t = 1; t < row.length; t++) if (row[t]! > row[best]!) best = t;
        if (best === EOS_TOKEN) {
          done[j] = true;
          remaining--;
          continue;
        }
        const rowIds = ids[j]!;
        rowIds.push(best);
        const cut = runawayTruncateLen(rowIds);
        if (cut !== null) {
          rowIds.length = cut;
          done[j] = true;
          remaining--;
        }
      }
      if (selective) logits.dispose();
      useBranch = true;
    }
  } finally {
    if (selective) for (const tensor of Object.values(past)) tensor.dispose();
  }
  return { ids, ms: performance.now() - t0 };
}

const sameIds = (a: number[][], b: number[][]): boolean =>
  a.length === b.length && a.every((row, j) => row.join() === b[j]!.join());

const MODEL = join(
  import.meta.dirname,
  "..",
  "public",
  "ocr-models",
  "decoder_model_merged_batch_int8.onnx",
);
const dec = await ort.InferenceSession.create(MODEL, {
  executionProviders: ["cpu"],
});
console.log(`decoder: ${MODEL}`);

let failed = false;
for (const batch of [1, 4]) {
  const rand = mulberry32(0xc0ffee ^ batch);
  const hidden = randomHidden(rand, batch);
  const old = await decode(dec, hidden, false);
  const sel = await decode(dec, hidden, true);
  hidden.dispose();
  const ok = sameIds(old.ids, sel.ids);
  if (!ok) failed = true;
  const lens = sel.ids.map((row) => row.length - 1).join(",");
  console.log(
    `${ok ? "✓" : "✗"} batch ${batch}: tokens exact-match | lens [${lens}] | ` +
      `all-outputs ${old.ms.toFixed(0)}ms vs selective ${sel.ms.toFixed(0)}ms`,
  );
  if (!ok) {
    for (let j = 0; j < batch; j++)
      console.log(`  row ${j}\n    old: ${old.ids[j]}\n    sel: ${sel.ids[j]}`);
  }
}

console.log(failed ? "\nSELECTIVE FETCH: FAIL" : "\nSELECTIVE FETCH: PASS");
process.exit(failed ? 1 : 0);
