#!/usr/bin/env python3
"""Export a trained compact checkpoint to ONNX (fp32) + int8 quantized.

Usage:
    python export_compact_onnx.py <checkpoint.pth> [--seconds 5] [--out dir]

The compact model outputs frame/onset/offset rolls; the KeySync service
converts them to note events with the same post-processing as Kong's model.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("--seconds", type=int, default=5)
    ap.add_argument("--out", default=".")
    args = ap.parse_args()

    import numpy as np
    import torch
    import torch.nn as nn

    from conformer2d_compact import Conformer2DCompact, Conformer2DCompactConfig

    try:
        from piano_transcription.models.rope import build_rope  # noqa
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "upstream-training"))
    except ImportError:
        pass

    print("building compact model...", flush=True)
    cfg = Conformer2DCompactConfig()
    model = Conformer2DCompact(cfg)
    ckpt = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(ckpt)
    del ckpt
    model.eval()

    class Wrapper(nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, x):
            # x: (b, 1, samples) like the upstream model
            out = self.m(x)
            return out["frame_roll"], out["onset_roll"], out["offset_roll"]

    wrapper = Wrapper(model).eval()
    samples = 16000 * args.seconds
    dummy = torch.zeros(1, 1, samples)

    os.makedirs(args.out, exist_ok=True)
    fp32_path = os.path.join(args.out, "keysync_compact_fp32.onnx")
    print(f"exporting {args.seconds}s fp32 onnx...", flush=True)
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            dummy,
            fp32_path,
            input_names=["waveform"],
            output_names=["frame_roll", "onset_roll", "offset_roll"],
            opset_version=17,
        )
    print(f"fp32: {os.path.getsize(fp32_path) / 1e6:.1f} MB", flush=True)

    # Sanity: fp32 onnx matches pytorch on noise.
    import onnxruntime as ort

    clip = np.random.randn(1, 1, samples).astype(np.float32)
    with torch.no_grad():
        ref = [r.numpy() for r in wrapper(torch.from_numpy(clip))]
    sess = ort.InferenceSession(fp32_path, providers=["CPUExecutionProvider"])
    got = sess.run(None, {"waveform": clip})
    d = max(float(np.abs(a - b).max()) for a, b in zip(ref, got))
    print(f"max abs diff pytorch vs fp32 onnx: {d:.2e}", flush=True)

    from onnxruntime.quantization import QuantType, quantize_dynamic

    int8_path = os.path.join(args.out, "keysync_compact_int8.onnx")
    print("quantizing to int8...", flush=True)
    quantize_dynamic(fp32_path, int8_path, weight_type=QuantType.QInt8)
    print(f"int8: {os.path.getsize(int8_path) / 1e6:.1f} MB", flush=True)

    sess = ort.InferenceSession(int8_path, providers=["CPUExecutionProvider"])
    got_q = sess.run(None, {"waveform": clip})
    dq = max(float(np.abs(a - b).max()) for a, b in zip(ref, got_q))
    print(f"max abs diff pytorch vs int8 onnx: {dq:.2e}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
