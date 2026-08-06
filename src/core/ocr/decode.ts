import { ort, type Tensor } from "./ort-runtime";
import type { OcrModels } from "./models";

// The recognition decoder half of the OCR pipeline: greedy char-WordPiece
// decoding over the manga-ocr encoder output. The proven trap stays fixed:
// the decoder logits stride is the tensor's own dims[2] (vocab.txt has a
// trailing newline — never index it by vocab.length).

const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_TOKENS = 300;
/** KV-cache decoder shape constants (merged model: 2 BERT layers, 12 heads). */
const KV_LAYERS = 2;
const KV_HEADS = 12;
const KV_DIM = 64;
// Runaway guard: on non-text texture (screentone, barcodes, book-spine
// patterns) the decoder loops — 300 dots, ははは…, 第条第条… A/B showed fp32
// weights loop on the same pages, so it is structural, not quantization.
// Stop the loop and trim the tail; real screams never reach these runs.
/** Same token this many times in a row = runaway (keep RUN_KEEP of them). */
const MAX_SAME_RUN = 15;
/** A 2..4-token cycle repeated to this total length = runaway. */
const MAX_CYCLE_RUN = 12;
const RUN_KEEP = 3;

/** If the generated tail of `ids` (after START) is a repeat run or a short
    cycle, return the length to truncate to; otherwise null. */
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

// Optional per-stage timing (dev probes): when enabled, ocrPage logs how the
// page's time split between detection, canvas crops, the encoder and the
// decoder loop — the data pool-size and backend decisions are made from.
export interface OcrTiming {
  crop: number;
  enc: number;
  dec: number;
}

/** Greedy KV-cache decode of a WHOLE batch of blocks in lockstep: one
    decoder run per step advances every row at once (the shipped merged
    decoder has a dynamic batch dim). Every row starts at START together, so
    the batch is always rectangular — input_ids [B,1] each step, mask [B,
    step+1]; a row that hits EOS or the runaway guard is then fed EOS and
    ignored. The encoder output is always [B,197,768], so cross-attention
    needs no mask. Exported and validated in-house: batched output is
    token-exact vs solo decode (/tmp/mocr-validate-batch.py).
    Selective fetch: step 0 fetches every output (encoder KV included);
    every later step fetches only logits + the four decoder presents — the
    encoder cross-attention KV is constant while `hidden` is, so the
    step-0 encoder tensors are fed back unchanged. Dead tensors (per-step
    inputs, logits, displaced KV) are disposed right after each awaited
    run; everything still owned is drained in finally. `hidden` belongs to
    the caller and is never disposed here.
    Returns the cleaned text per row — "" when the crop reads as empty. */
export async function decodeBlocks(
  models: OcrModels,
  hidden: Tensor,
  timing?: OcrTiming,
): Promise<string[]> {
  const t0 = performance.now();
  const batch = hidden.dims[0]!;
  const ids: number[][] = Array.from({ length: batch }, () => [START_TOKEN]);
  const done = new Array<boolean>(batch).fill(false);
  let remaining = batch;
  const past: Record<string, Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32",
          new Float32Array(0),
          [batch, KV_HEADS, 0, KV_DIM],
        );
  const laterFetch = [
    "logits",
    ...models.decoder.outputNames.filter((name) =>
      /^present\.\d+\.decoder\./.test(name),
    ),
  ];
  let useBranch = false;
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
      const feeds: Record<string, Tensor> = {
        input_ids: inputIds,
        encoder_hidden_states: hidden,
        attention_mask: mask,
        use_cache_branch: branch,
      };
      Object.assign(feeds, past);
      let decOut;
      try {
        decOut = useBranch
          ? await models.decoder.run(feeds, laterFetch)
          : await models.decoder.run(feeds);
      } finally {
        inputIds.dispose();
        mask.dispose();
        branch.dispose();
      }
      // Only the fetched presents come back; the displaced KV (step-0
      // empties, then the previous step's decoder KV) is dead. Encoder KV
      // is never re-fetched after step 0, so it stays live until finally.
      for (const name of Object.keys(decOut)) {
        if (!name.startsWith("present.")) continue;
        const pastName = name.replace("present", "past_key_values");
        past[pastName]!.dispose();
        past[pastName] = decOut[name]!;
      }
      const logits = decOut.logits!;
      // Trap 3: the vocab stride comes from the tensor, not vocab.txt. Logits
      // are [B, 1, vocab] — row j is one flat slice.
      const stride = logits.dims[2]!;
      const ldata = logits.data as Float32Array;
      for (let j = 0; j < batch; j++) {
        if (done[j]) continue;
        const row = ldata.subarray(j * stride, (j + 1) * stride);
        let best = 0;
        for (let i = 1; i < row.length; i++) if (row[i]! > row[best]!) best = i;
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
      logits.dispose();
      useBranch = true;
    }
  } finally {
    for (const tensor of Object.values(past)) tensor.dispose();
  }
  if (timing) timing.dec += performance.now() - t0;
  return ids.map((rowIds) =>
    rowIds
      .slice(1)
      .map((id) => models.vocab[id] ?? "")
      .filter((token) => !/^(\[|<unused)/.test(token))
      .join("")
      .replace(/##/g, "")
      .trim(),
  );
}
