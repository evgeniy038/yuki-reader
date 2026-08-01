#!/usr/bin/env python3
"""Export manga-ocr BERT decoder with KV-cache AND a dynamic batch dim:
no-past + with-past graphs, then merge.

Same as mocr-export.py, but every input/output carries {0: "batch"} so one
OrtRun decodes a whole batch of crops in lockstep. BERT decoders are rejected
by optimum CLI, so both flavours are manual torch.onnx.export graphs fused by
merge_decoders (adds the use_cache_branch If node).
"""
import torch
import onnx
from transformers import VisionEncoderDecoderModel
from optimum.onnx.graph_transformations import merge_decoders

OUT = "/tmp/mocr-batch"
NLAYERS = 2

m = VisionEncoderDecoderModel.from_pretrained("kha-white/manga-ocr-base")
dec = m.decoder.eval()
for p in dec.parameters():
    p.requires_grad_(False)
H = dec.config.hidden_size


def flat_past(cache):
    return [t for layer in cache.to_legacy_cache() for t in layer]


class DecNoPast(torch.nn.Module):
    def forward(self, input_ids, attention_mask, encoder_hidden_states):
        out = dec(input_ids=input_ids, attention_mask=attention_mask,
                  encoder_hidden_states=encoder_hidden_states, use_cache=True)
        return (out.logits, *flat_past(out.past_key_values))


class DecWithPast(torch.nn.Module):
    def forward(self, input_ids, attention_mask, encoder_hidden_states, *past):
        layers = tuple(tuple(past[i * 4:(i + 1) * 4]) for i in range(NLAYERS))
        out = dec(input_ids=input_ids, attention_mask=attention_mask,
                  encoder_hidden_states=encoder_hidden_states,
                  past_key_values=layers, use_cache=True)
        return (out.logits, *flat_past(out.past_key_values))


PAST_NAMES = [f"past_key_values.{l}.{kind}.{kv}"
              for l in range(NLAYERS)
              for kind in ("decoder", "encoder")
              for kv in ("key", "value")]
PRESENT_NAMES = [n.replace("past_key_values", "present") for n in PAST_NAMES]

ids = torch.tensor([[2, 100, 200]])
am = torch.ones_like(ids)
ehs = torch.randn(1, 16, H)

# Everything is batched: axis 0 is "batch" on every input and output.
dyn_common = {
    "input_ids": {0: "batch", 1: "seq"},
    "attention_mask": {0: "batch", 1: "total_seq"},
    "encoder_hidden_states": {0: "batch", 1: "enc_seq"},
    "logits": {0: "batch", 1: "seq"},
}
for l in range(NLAYERS):
    for kind, seq in (("decoder", "seq"), ("encoder", "enc_seq")):
        for kv in ("key", "value"):
            dyn_common[f"present.{l}.{kind}.{kv}"] = {0: "batch", 2: seq}

import os
os.makedirs(OUT, exist_ok=True)

with torch.no_grad():
    torch.onnx.export(
        DecNoPast(), (ids, am, ehs), f"{OUT}/decoder_np.onnx",
        input_names=["input_ids", "attention_mask", "encoder_hidden_states"],
        output_names=["logits", *PRESENT_NAMES],
        dynamic_axes=dyn_common, opset_version=17, do_constant_folding=False, dynamo=False,
    )
print("no-past exported")

with torch.no_grad():
    ref = DecNoPast()(ids, am, ehs)
past = ref[1:]
dyn_past = dict(dyn_common)
for l in range(NLAYERS):
    for kind, seq in (("decoder", "past_seq"), ("encoder", "enc_seq")):
        for kv in ("key", "value"):
            dyn_past[f"past_key_values.{l}.{kind}.{kv}"] = {0: "batch", 2: seq}

with torch.no_grad():
    torch.onnx.export(
        DecWithPast(), (ids[:, :1], torch.ones(1, 4, dtype=torch.int64), ehs, *past),
        f"{OUT}/decoder_wp.onnx",
        input_names=["input_ids", "attention_mask", "encoder_hidden_states", *PAST_NAMES],
        output_names=["logits", *PRESENT_NAMES],
        dynamic_axes=dyn_past, opset_version=17, do_constant_folding=False, dynamo=False,
    )
print("with-past exported")

merged = merge_decoders(f"{OUT}/decoder_np.onnx", f"{OUT}/decoder_wp.onnx",
                        graph_name="decoder_merged", save_path=f"{OUT}/decoder_model_merged.onnx")
print("merged inputs:", [i.name for i in merged.graph.input][:6], "...")
