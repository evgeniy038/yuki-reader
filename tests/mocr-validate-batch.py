#!/usr/bin/env python3
"""Validate the dynamic-batch merged decoder.

1. batch=1: ORT greedy == HF full-prefix greedy (sanity, as mocr-validate.py).
2. batch=4: lockstep batched greedy == the same 4 rows decoded solo (exact).
Runs both checks on the fp32 merged model and the int8 one.
"""
import numpy as np
import onnxruntime as ort
import torch
from transformers import VisionEncoderDecoderModel

NLAYERS, HEADS, HDIM, H = 2, 12, 64, 768
START, EOS, MAX_STEPS = 2, 3, 30

PAST_NAMES = [f"past_key_values.{l}.{kind}.{kv}"
              for l in range(NLAYERS)
              for kind in ("decoder", "encoder")
              for kv in ("key", "value")]


def batched_greedy(sess, ehs_batch):
    """Lockstep greedy over a batch, JS-pipeline semantics: EOS never enters
    ids; finished rows are fed EOS and ignored."""
    B = ehs_batch.shape[0]
    ids = np.full((B, 1), START, dtype=np.int64)
    done = np.zeros(B, dtype=bool)
    past = {n: np.zeros((B, HEADS, 0, HDIM), dtype=np.float32) for n in PAST_NAMES}
    collected = [[] for _ in range(B)]
    use_branch = False
    for _ in range(MAX_STEPS):
        last = ids[:, -1:]
        feeds = {
            "input_ids": np.where(done[:, None], EOS, last).astype(np.int64)
            if use_branch else ids,
            "attention_mask": np.ones((B, ids.shape[1]), dtype=np.int64),
            "encoder_hidden_states": ehs_batch,
            "use_cache_branch": np.array([use_branch]),
            **past,
        }
        outs = sess.run(None, feeds)
        logits = outs[0]
        past = {n: outs[i + 1] for i, n in enumerate(PAST_NAMES)}
        nxt = logits[:, -1, :].argmax(-1)
        ids = np.concatenate([ids, nxt[:, None].astype(np.int64)], 1)
        for j in range(B):
            if done[j]:
                continue
            if nxt[j] == EOS:
                done[j] = True
            else:
                collected[j].append(int(nxt[j]))
        use_branch = True
        if done.all():
            break
    return collected


def hf_greedy(dec, ehs):
    ids = [START]
    with torch.no_grad():
        ehs_t = torch.from_numpy(ehs)
        for _ in range(MAX_STEPS):
            out = dec(input_ids=torch.tensor([ids]), encoder_hidden_states=ehs_t)
            nxt = int(out.logits[0, -1].argmax())
            if nxt == EOS:
                break
            ids.append(nxt)
    return ids[1:]


m = VisionEncoderDecoderModel.from_pretrained("kha-white/manga-ocr-base")
dec = m.decoder.eval()

rng = np.random.default_rng(42)
# Production encoder output is always [B, 197, 768] — rectangular, no padding.
# (Padding rows to a shared enc_seq with zeros would change cross-attention
# math: the decoder has no encoder attention mask. Never test that way.)
ENC_SEQ = 24
rows = [rng.standard_normal((1, ENC_SEQ, H), dtype=np.float32) for _ in range(4)]
batch = np.concatenate(rows, axis=0)

total_fails = 0
for path in ("/tmp/mocr-batch/decoder_model_merged.onnx",
             "/tmp/mocr-batch/decoder_model_merged_int8.onnx"):
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    solos = [batched_greedy(sess, r) for r in rows]
    solos = [s[0] for s in solos]
    batched = batched_greedy(sess, batch)
    name = path.split("/")[-1]
    ok = batched == solos
    print(f"{name}: batch==solo -> {ok}")
    if not ok:
        total_fails += 1
        for j, (b, s) in enumerate(zip(batched, solos)):
            if b != s:
                print(f"  row {j}: batched {b}\n         solo   {s}")
    hf = hf_greedy(dec, rows[0])
    ort_solo = batched_greedy(sess, rows[0])[0]
    ok_hf = ort_solo == hf
    print(f"{name}: batch1==HF -> {ok_hf}")
    if not ok_hf:
        total_fails += 1
        print(f"  HF : {hf}\n  ORT: {ort_solo}")

print("FAILS:", total_fails)
