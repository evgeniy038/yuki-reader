// Decoders for the quality harness twin of src/core/ocr/decode.ts: the
// shipped lockstep batched greedy decode (with its runaway guard), a
// full-prefix fallback for non-merged A/B decoders, and HF-style beam
// search for the beam A/B.
import * as ort from "onnxruntime-node";

const START_TOKEN = 2;
const EOS_TOKEN = 3;
const MAX_TOKENS = 300;
// Runaway guard (1:1 with decode.ts): decoder repeat/cycle loops on
// non-text texture; fp32 does not fix it. Stop + trim the tail.
const MAX_SAME_RUN = 15;
const MAX_CYCLE_RUN = 12;
const RUN_KEEP = 3;
const KV_LAYERS = 2;
const KV_HEADS = 12;
const KV_DIM = 64;

export function runawayTruncateLen(ids: number[]): number | null {
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

/** Full-prefix greedy decode for non-merged A/B decoders (batch 1). */
export async function greedyDecodeFullPrefix(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
): Promise<number[]> {
  const ids: number[] = [START_TOKEN];
  for (let step = 0; step < MAX_TOKENS; step++) {
    const decOut = await dec.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      encoder_hidden_states: hidden,
    });
    const logits = decOut.logits!.data as Float32Array;
    const stride = decOut.logits!.dims[2]!;
    const row = logits.subarray((ids.length - 1) * stride, ids.length * stride);
    let best = 0;
    for (let t = 1; t < row.length; t++) if (row[t]! > row[best]!) best = t;
    if (best === EOS_TOKEN) break;
    ids.push(best);
    const cut = runawayTruncateLen(ids);
    if (cut !== null) {
      ids.length = cut;
      break;
    }
  }
  return ids;
}

// Lockstep batched greedy decode (1:1 with decode.ts decodeBlocks): one
// run per step advances the whole batch; rows all start at START together,
// so every step is rectangular — input_ids [B,1], mask [B, step+1]. A row
// that hits EOS or the runaway guard is then fed EOS and ignored.
export async function greedyDecodeBatch(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
): Promise<number[][]> {
  const batch = hidden.dims[0]!;
  const ids: number[][] = Array.from({ length: batch }, () => [START_TOKEN]);
  const done = new Array<boolean>(batch).fill(false);
  let remaining = batch;
  const past: Record<string, ort.Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32", new Float32Array(0), [batch, KV_HEADS, 0, KV_DIM]);
  let useBranch = false;
  for (let step = 0; step < MAX_TOKENS && remaining > 0; step++) {
    const tokens = new BigInt64Array(batch);
    for (let j = 0; j < batch; j++) {
      const row = ids[j]!;
      tokens[j] = BigInt(
        !useBranch ? START_TOKEN : done[j] ? EOS_TOKEN : row[row.length - 1]!,
      );
    }
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", tokens, [batch, 1]),
      encoder_hidden_states: hidden,
      attention_mask: new ort.Tensor(
        "int64", new BigInt64Array(batch * (step + 1)).fill(1n), [batch, step + 1]),
      use_cache_branch: new ort.Tensor("bool", new Uint8Array([useBranch ? 1 : 0]), [1]),
      ...past,
    };
    const decOut = await dec.run(feeds);
    for (const name of dec.outputNames)
      if (name.startsWith("present."))
        past[name.replace("present", "past_key_values")] = decOut[name]!;
    const logits = decOut.logits!.data as Float32Array;
    const stride = decOut.logits!.dims[2]!;
    for (let j = 0; j < batch; j++) {
      if (done[j]) continue;
      const row = logits.subarray(j * stride, (j + 1) * stride);
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
    useBranch = true;
  }
  return ids;
}

// Beam search as HF generate() runs it for manga-ocr's config.json
// (num_beams=4, no_repeat_ngram_size=3, length_penalty=2.0,
// early_stopping=True, max_length=300). Rows = crops × beams advance in one
// decoder run per step; the decoder self-attention KV is gathered by
// parent beam after every step (the encoder KV is identical across a
// crop's beams, so it never moves).
const NO_REPEAT_NGRAM = 3;
const LENGTH_PENALTY = 2.0;

interface Hyp {
  ids: number[];
  score: number;
}

function logSoftmax(row: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < row.length; i++) if (row[i]! > max) max = row[i]!;
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.exp(row[i]! - max);
  const lse = max + Math.log(sum);
  const out = new Float32Array(row.length);
  for (let i = 0; i < row.length; i++) out[i] = row[i]! - lse;
  return out;
}

/** Tokens that would repeat an n-gram already in `ids` (HF
    NoRepeatNGramLogitsProcessor; the history includes the start token). */
function bannedNext(ids: number[]): Set<number> {
  const banned = new Set<number>();
  const n = NO_REPEAT_NGRAM;
  if (ids.length + 1 < n) return banned;
  const prefix = ids.slice(ids.length - (n - 1));
  for (let i = 0; i + n - 1 < ids.length; i++) {
    let same = true;
    for (let j = 0; j < n - 1; j++) if (ids[i + j] !== prefix[j]) { same = false; break; }
    if (same) banned.add(ids[i + n - 1]!);
  }
  return banned;
}

export async function beamDecodeBatch(
  dec: ort.InferenceSession,
  hidden: ort.Tensor,
  K: number,
): Promise<number[][]> {
  const B = hidden.dims[0]!;
  const seq = hidden.dims[1]!;
  const dim = hidden.dims[2]!;
  const R = B * K;
  const src = hidden.data as Float32Array;
  const rep = new Float32Array(R * seq * dim);
  for (let b = 0; b < B; b++)
    for (let k = 0; k < K; k++)
      rep.set(src.subarray(b * seq * dim, (b + 1) * seq * dim), (b * K + k) * seq * dim);
  const hiddenRep = new ort.Tensor("float32", rep, [R, seq, dim]);
  // beams[b][k]: live hypotheses; HF starts with beam 0 at 0, the rest at
  // -1e9 so step 0 expands a single beam.
  const beams: Hyp[][] = Array.from({ length: B }, () =>
    Array.from({ length: K }, (_, k) => ({ ids: [START_TOKEN], score: k === 0 ? 0 : -1e9 })),
  );
  const finished: Hyp[][] = Array.from({ length: B }, () => []);
  const done = new Array<boolean>(B).fill(false);
  let past: Record<string, ort.Tensor> = {};
  for (let l = 0; l < KV_LAYERS; l++)
    for (const kind of ["decoder", "encoder"])
      for (const kv of ["key", "value"])
        past[`past_key_values.${l}.${kind}.${kv}`] = new ort.Tensor(
          "float32", new Float32Array(0), [R, KV_HEADS, 0, KV_DIM]);
  for (let step = 0; step < MAX_TOKENS - 1 && done.some((d) => !d); step++) {
    const tokens = new BigInt64Array(R);
    for (let b = 0; b < B; b++)
      for (let k = 0; k < K; k++) {
        const ids = beams[b]![k]!.ids;
        tokens[b * K + k] = BigInt(done[b] ? EOS_TOKEN : ids[ids.length - 1]!);
      }
    const out = await dec.run({
      input_ids: new ort.Tensor("int64", tokens, [R, 1]),
      encoder_hidden_states: hiddenRep,
      attention_mask: new ort.Tensor("int64", new BigInt64Array(R * (step + 1)).fill(1n), [R, step + 1]),
      use_cache_branch: new ort.Tensor("bool", new Uint8Array([step > 0 ? 1 : 0]), [1]),
      ...past,
    });
    const logits = out.logits!.data as Float32Array;
    const V = out.logits!.dims[2]!;
    const parents = new Int32Array(R);
    for (let b = 0; b < B; b++) {
      parents.fill(b * K, b * K, (b + 1) * K);
      if (done[b]) continue;
      // Top 2K candidates over K beams × V tokens.
      const cand: { score: number; k: number; tok: number; lp: number }[] = [];
      for (let k = 0; k < K; k++) {
        const hyp = beams[b]![k]!;
        const lp = logSoftmax(logits.subarray((b * K + k) * V, (b * K + k + 1) * V));
        for (const t of bannedNext(hyp.ids)) lp[t] = -Infinity;
        for (let t = 0; t < V; t++) {
          const sc = hyp.score + lp[t]!;
          if (cand.length < 2 * K || sc > cand[cand.length - 1]!.score) {
            let at = cand.length;
            while (at > 0 && cand[at - 1]!.score < sc) at--;
            cand.splice(at, 0, { score: sc, k, tok: t, lp: lp[t]! });
            if (cand.length > 2 * K) cand.pop();
          }
        }
      }
      const next: Hyp[] = [];
      const nextParent: number[] = [];
      for (let rank = 0; rank < cand.length && next.length < K; rank++) {
        const c = cand[rank]!;
        const parent = beams[b]![c.k]!;
        if (c.tok === EOS_TOKEN) {
          // HF: only EOS candidates ranked within the first K count.
          if (rank >= K) continue;
          const generated = parent.ids.length; // tokens after START, plus EOS
          finished[b]!.push({ ids: parent.ids, score: c.score / generated ** LENGTH_PENALTY });
          continue;
        }
        next.push({ ids: [...parent.ids, c.tok], score: c.score });
        nextParent.push(c.k);
      }
      while (next.length < K) {
        next.push({ ids: [...beams[b]![0]!.ids], score: -1e9 });
        nextParent.push(0);
      }
      beams[b] = next;
      for (let k = 0; k < K; k++) parents[b * K + k] = b * K + nextParent[k]!;
      // early_stopping=True: done once K hypotheses have finished.
      if (finished[b]!.length >= K) done[b] = true;
    }
    // Gather the decoder self-attention KV by parent row.
    const nextPast: Record<string, ort.Tensor> = {};
    for (const name of dec.outputNames) {
      if (!name.startsWith("present.")) continue;
      const pastName = name.replace("present", "past_key_values");
      const t = out[name]!;
      if (name.includes(".encoder.")) {
        nextPast[pastName] = t;
        continue;
      }
      const data = t.data as Float32Array;
      const rowSize = data.length / R;
      const moved = new Float32Array(data.length);
      for (let r = 0; r < R; r++)
        moved.set(data.subarray(parents[r]! * rowSize, (parents[r]! + 1) * rowSize), r * rowSize);
      nextPast[pastName] = new ort.Tensor("float32", moved, t.dims as number[]);
    }
    past = nextPast;
  }
  // max_length reached: live beams join the finished pool.
  return Array.from({ length: B }, (_, b) => {
    const pool = [
      ...finished[b]!,
      ...(done[b]
        ? []
        : beams[b]!.map((h) => ({ ids: h.ids, score: h.score / Math.max(1, h.ids.length - 1) ** LENGTH_PENALTY }))),
    ];
    pool.sort((x, y) => y.score - x.score);
    return pool[0]?.ids ?? [START_TOKEN];
  });
}
