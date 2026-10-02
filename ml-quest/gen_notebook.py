#!/usr/bin/env python3
"""Generate ml-quest/kaggle-train.ipynb (Kaggle notebook JSON).

Cell contents are plain triple-quoted strings. Notebook f-strings like
f"{WORK}" are written literally (no generator interpolation). The two
values that DO interpolate (GH_RAW, UPSTREAM) are spliced via concatenation.
"""
import json

GH_RAW = "https://raw.githubusercontent.com/pratham-jain33/keysync/master/ml-quest"
UPSTREAM = "https://github.com/qiuqiangkong/piano_transcription"

cells = []


def md(source):
    cells.append({"cell_type": "markdown", "metadata": {},
                  "source": source.splitlines(keepends=True)})


def code(source):
    cells.append({"cell_type": "code", "execution_count": None,
                  "metadata": {}, "outputs": [],
                  "source": source.splitlines(keepends=True)})


md("""# KeySync compact piano model: training on a free Kaggle GPU

Trains a small (~4.6M parameter) piano transcription model on the MAESTRO
dataset, using Kong's open training code plus our compact model patch.
The result is exported to ONNX and quantized to int8 so it fits in the
512MB free Render container that runs KeySync.

What you need: a Kaggle account with GPU enabled (Settings -> Accelerator ->
GPU T4 x2). The free weekly GPU quota is enough for one full run.

Plan:
1. Download ~14 hours of MAESTRO piano recordings (2015 split, ~9GB)
2. Train the compact model (~6-10 hours on a T4)
3. Evaluate note F1 on the test split
4. Export to ONNX + int8, download the files

If the run gets interrupted, re-run from the top: training resumes from the
latest checkpoint automatically (set RESUME_CKPT below).""")

code("""# ---- Your settings ----
YEARS = ["2015"]          # MAESTRO year folders to train on (2015 ~= 14h, ~9GB)
TRAINING_STEPS = 100000   # 100k steps ~= full run; 20000 for a quick smoke test
BATCH_SIZE = 8            # lower to 4 if the GPU runs out of memory
RESUME_CKPT = ""          # e.g. "/kaggle/working/checkpoints/train/compact-conformer/step=20000.pth"
WORK = "/kaggle/working"
print("settings ok")""")

code("""!nvidia-smi --query-gpu=name,memory.total --format=csv
import torch
print("cuda available:", torch.cuda.is_available())
print("device:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NONE - enable GPU in Settings")""")

code("""import shutil
free_gb = shutil.disk_usage("/kaggle/working").free / 1e9
print(f"free disk: {free_gb:.1f} GB")
assert free_gb > 15, "need 15GB+ free disk"
""")

code("""# torch is preinstalled on Kaggle; add the training deps
!pip install -q einops audidata==0.0.3 librosa==0.10.2 pretty_midi==0.2.10 mir_eval==0.8.0 accelerate==1.2.1 tqdm""")

code("""import os
os.makedirs(f"{WORK}/ml-quest", exist_ok=True)
os.chdir(f"{WORK}/ml-quest")
# Our helper files live in the KeySync repo
FILES = ["fetch_maestro_subset.py", "conformer2d_compact.py",
         "patch_training_repo.py", "compact-conformer.yaml",
         "export_compact_onnx.py"]
for f in FILES:
    url = GH_RAW_PLACEHOLDER + "/" + f
    print("fetching", f)
    assert os.system(f"curl -sSL --retry 3 -o {f} {url}") == 0, f"failed: {f}"
print("helpers ready")""".replace("GH_RAW_PLACEHOLDER", chr(34) + GH_RAW + chr(34)))

code("""import os
os.chdir(f"{WORK}/ml-quest")
if not os.path.exists("upstream-training"):
    assert os.system("git clone -q " + UPSTREAM_PLACEHOLDER + " upstream-training") == 0
assert os.system("python patch_training_repo.py upstream-training") == 0
print("training repo patched for Conformer2DCompact")""".replace("UPSTREAM_PLACEHOLDER", chr(34) + UPSTREAM + chr(34)))

code("""import os
os.chdir(f"{WORK}/ml-quest")
# Downloads only the YEARS folders (wav+midi) via HTTP range requests,
# so we never fetch the full 108GB zip.
yrs = " ".join(YEARS)
ret = os.system(f"python fetch_maestro_subset.py datasets/maestro-v3.0.0 {yrs}")
assert ret == 0, "maestro download failed"
print("dataset subset ready")""")

code("""import os, csv
from collections import Counter
root = f"{WORK}/ml-quest/datasets/maestro-v3.0.0"
csv_path = os.path.join(root, "maestro-v3.0.0.csv")
rows = list(csv.DictReader(open(csv_path)))
kept = [r for r in rows if os.path.exists(os.path.join(root, r["audio_filename"]))]
print(f"rows: {len(rows)} -> {len(kept)} with audio on disk")
print("split counts:", dict(Counter(r["split"] for r in kept)))
hours = sum(float(r["duration"]) for r in kept) / 3600
print(f"total audio: {hours:.1f} hours")
with open(csv_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=rows[0].keys())
    w.writeheader()
    w.writerows(kept)
print("csv filtered to downloaded files")""")

md("""## The compact model

Kong's full model is ~150M+ parameters (628MB checkpoint). Ours keeps the
same architecture family (mel spectrogram -> conv blocks -> conformer
encoder/decoder -> frame/onset/offset rolls) but shrinks it:

- embedding width 1024 -> 256
- encoder/decoder layers 6+6 -> 2+2
- attention heads 16 -> 4

Result: ~4.6M parameters (~18MB fp32, ~5MB int8). The patch script already
copied it into the training repo and taught `train.py` about it.""")

code("""import os, re
os.chdir(f"{WORK}/ml-quest")
cfg = open("compact-conformer.yaml").read()
root = f"{WORK}/ml-quest/datasets/maestro-v3.0.0"
cfg = cfg.replace("/kaggle/working/datasets/maestro-v3.0.0", root)
cfg = re.sub(r"training_steps: \\d+", f"training_steps: {TRAINING_STEPS}", cfg)
cfg = re.sub(r"batch_size_per_device: \\d+", f"batch_size_per_device: {BATCH_SIZE}", cfg)
if RESUME_CKPT:
    cfg = re.sub(r"resume_ckpt_path:.*", f'resume_ckpt_path: "{RESUME_CKPT}"', cfg)
open("upstream-training/compact-conformer.yaml", "w").write(cfg)
print("config written:")
print(open("upstream-training/compact-conformer.yaml").read())""")

code("""import os
os.chdir(f"{WORK}/ml-quest/upstream-training")
# This is the long step: ~6-10h for 100k steps on a T4. Keep the tab open.
# Checkpoints save every 10k steps to ./checkpoints/train/compact-conformer/
ret = os.system("python train.py --config ./compact-conformer.yaml --no_log")
print("train exit:", ret)""")

code("""import os, glob
ckpts = sorted(glob.glob(f"{WORK}/ml-quest/upstream-training/checkpoints/train/compact-conformer/*.pth"))
for c in ckpts:
    print(f"{os.path.getsize(c)/1e6:.1f} MB  {os.path.basename(c)}")
print("latest:", ckpts[-1] if ckpts else "NONE")""")

md("""## Evaluate

Runs the trained model over the MAESTRO test split and reports
precision / recall / F1 for notes. This is the honest number: it tells us
whether the small model is actually good, not just small.""")

code("""import os, glob
os.chdir(f"{WORK}/ml-quest/upstream-training")
ckpts = sorted(glob.glob("checkpoints/train/compact-conformer/*.pth"))
ckpt = ckpts[-1]
print("evaluating", ckpt)
ret = os.system(f"python evaluate.py --config_yaml ./compact-conformer.yaml --ckpt_path {ckpt} --results_dir ./results/compact")
print("evaluate exit:", ret)""")

md("""## Export for KeySync

Converts the best checkpoint to ONNX and quantizes to int8. These two
files are what the Render service loads.""")

code("""import os, glob
os.chdir(f"{WORK}/ml-quest")
ckpts = sorted(glob.glob("upstream-training/checkpoints/train/compact-conformer/*.pth"))
ckpt = ckpts[-1]
os.makedirs("export", exist_ok=True)
ret = os.system(f"python export_compact_onnx.py {ckpt} --seconds 5 --out export")
assert ret == 0
print("export done. Files to download from the export/ folder:")
print(os.listdir("export"))""")

nb = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.10.0"},
        "accelerator": "GPU",
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

out = "/home/hatch/workspace/piano-app/ml-quest/kaggle-train.ipynb"
with open(out, "w") as f:
    json.dump(nb, f, indent=1)

# validate: parses as JSON, every cell has source lines, code cells compile
nb2 = json.load(open(out))
assert nb2["nbformat"] == 4
import ast as _ast
for c in nb2["cells"]:
    assert c["cell_type"] in ("markdown", "code"), c["cell_type"]
    src = "".join(c["source"])
    assert src.strip(), "empty cell"
    if c["cell_type"] == "code":
        py = "\n".join(x for x in src.splitlines() if not x.strip().startswith("!"))
        if py.strip():
            _ast.parse(py)
