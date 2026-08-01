#!/usr/bin/env python3
"""Dump ONNX model inputs/outputs with names, dtypes and shapes."""
import sys

import onnx


def dump(path: str) -> None:
    m = onnx.load(path, load_external_data=False)
    print(f"== {path}")
    print("inputs:")
    for i in m.graph.input:
        t = i.type.tensor_type
        shape = [d.dim_param or d.dim_value for d in t.shape.dim]
        print(f"  {i.name}: dtype={t.elem_type} shape={shape}")
    print("outputs:")
    for o in m.graph.output:
        t = o.type.tensor_type
        shape = [d.dim_param or d.dim_value for d in t.shape.dim]
        print(f"  {o.name}: dtype={t.elem_type} shape={shape}")


for p in sys.argv[1:]:
    dump(p)
