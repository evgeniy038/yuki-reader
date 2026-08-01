#!/usr/bin/env python3
"""Fold Constant nodes to initializers, quantize int8, then merge."""
import onnx
from onnxruntime.quantization import quantize_dynamic, QuantType
from optimum.onnx.graph_transformations import merge_decoders

OUT = "/tmp/mocr-batch"


def constants_to_initializers(src: str, dst: str) -> None:
    m = onnx.load(src)
    g = m.graph
    keep = []
    moved = 0
    for node in g.node:
        if node.op_type == "Constant" and len(node.attribute) == 1 \
                and node.attribute[0].name == "value":
            t = node.attribute[0].t
            init = onnx.TensorProto()
            init.CopyFrom(t)
            init.name = node.output[0]
            init.doc_string = ""
            g.initializer.append(init)
            moved += 1
        else:
            keep.append(node)
    del g.node[:]
    g.node.extend(keep)
    onnx.save(m, dst)
    print(src.split("/")[-1], "moved constants:", moved)


def fold_weight_transforms(path: str) -> None:
    """Bake Transpose/Reshape/Unsqueeze of initializers into new initializers,
    so MatMul nodes see a direct weight and quantize_dynamic can take them."""
    import numpy as np
    m = onnx.load(path)
    g = m.graph
    inits = {t.name: t for t in g.initializer}

    def to_np(t):
        return onnx.numpy_helper.to_array(t)

    changed = True
    folded = 0
    while changed:
        changed = False
        for node in list(g.node):
            if node.op_type not in ("Transpose", "Reshape", "Unsqueeze", "Squeeze"):
                continue
            src = node.input[0]
            if src not in inits:
                continue
            arr = to_np(inits[src])
            try:
                if node.op_type == "Transpose":
                    perm = list(node.attribute[0].ints) if node.attribute else None
                    out = np.transpose(arr, axes=perm)
                elif node.op_type == "Reshape":
                    shape_src = node.input[1]
                    if shape_src not in inits:
                        continue
                    out = np.reshape(arr, tuple(int(x) for x in to_np(inits[shape_src])))
                elif node.op_type == "Unsqueeze":
                    axes = to_np(inits[node.input[1]]) if len(node.input) > 1 else \
                        np.array(list(node.attribute[0].ints))
                    out = np.expand_dims(arr, tuple(int(x) for x in axes))
                else:
                    axes = to_np(inits[node.input[1]]) if len(node.input) > 1 else \
                        np.array(list(node.attribute[0].ints))
                    out = np.squeeze(arr, axis=tuple(int(x) for x in axes))
            except Exception:
                continue
            init = onnx.numpy_helper.from_array(out, name=node.output[0])
            g.initializer.append(init)
            inits[init.name] = init
            g.node.remove(node)
            folded += 1
            changed = True
    onnx.save(m, path)
    print(path.split("/")[-1], "folded weight transforms:", folded)



for name in ("decoder_np", "decoder_wp"):
    constants_to_initializers(f"{OUT}/{name}.onnx", f"{OUT}/{name}_pre.onnx")
    fold_weight_transforms(f"{OUT}/{name}_pre.onnx")
    quantize_dynamic(
        f"{OUT}/{name}_pre.onnx", f"{OUT}/{name}_int8.onnx",
        weight_type=QuantType.QInt8, per_channel=True,
    )
    m = onnx.load(f"{OUT}/{name}_int8.onnx", load_external_data=False)
    tot = {}
    for t in m.graph.initializer:
        tot.setdefault(t.data_type, 0)
        tot[t.data_type] += len(t.raw_data)
    print(name, "init MB by dtype:", {k: round(v / 1e6, 1) for k, v in tot.items()})

merge_decoders(f"{OUT}/decoder_np_int8.onnx", f"{OUT}/decoder_wp_int8.onnx",
               graph_name="decoder_merged", save_path=f"{OUT}/decoder_model_merged_int8.onnx")
print("merged ok")
