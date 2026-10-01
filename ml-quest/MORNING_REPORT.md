# Morning report: what got built overnight (Sep 30 - Oct 1)

Two tracks. One fixes production today. One is your ML quest.

## Track 1: the squeeze (fixes the 502s)

Problem: Kong's piano model transcribes better than Basic Pitch, but it needs
~927MB and Render gives us 512MB. Every real upload dies with a 502.

What I did:
1. Converted the model to ONNX format (portable, runs on ONNX Runtime instead
   of PyTorch). fp32 version peaked at ~501MB. Still too close to the wall.
2. Tried int8 quantization and REJECTED it: the outputs were crushed (max
   diff 0.13 vs fp32), onset peaks fell below threshold, zero notes detected
   on real Bach audio. A smaller model that hears nothing is not a solution.
3. Shrunk the input window to 2.5-second chunks instead. Smaller chunks =
   less memory per pass, and we stitch the results together.
4. Vendored the numpy-only post-processor (postproc.py, MIT from Kong's
   package) so the service never imports torch at all. requirements.txt
   dropped torch, scipy, and piano_transcription_inference entirely.

Status (Oct 1, ~00:30 IST): fp32 2.5s ONNX verified end to end. 138 notes on
30s of Bach (matches the 5s-window count), full Flask service peaks at
428MB on a 129s upload, comfortably under 512MB. Committed locally; needs
your GitHub push to deploy (I have no token while you sleep).

If it works, real uploads start working on the free tier. No paid upgrade,
no Basic Pitch fallback.

## Track 2: your ML quest (the real model)

Research result, verified: nobody has published a small ready-made piano
transcription model. The papers claim small models (PARcompact 2.7M,
HRplus 0.9M, HPPNet 1.2M) but none released a checkpoint you can download.
So the lane is open: we train our own.

What I built (in piano-app/ml-quest/):
- conformer2d_compact.py: our model. Same architecture family as Kong's
  (mel spectrogram -> conv blocks -> conformer encoder/decoder -> note rolls)
  but shrunk: 256-wide (was 1024), 2+2 layers (was 6+6), 4 heads (was 16).
  4.6M params, ~18MB. Verified it runs and outputs correct shapes.
- compact-conformer.yaml: training config (100k steps, batch 8, AdamW).
- patch_training_repo.py: plugs our model into Kong's open MIT training code.
- fetch_maestro_subset.py: downloads only the 2015 split of MAESTRO
  (~14h of piano, ~9GB) instead of the full 108GB.
- export_compact_onnx.py: trained checkpoint -> ONNX -> int8 for the service.
- kaggle-train.ipynb: the full pipeline in 17 notebook cells, ready to run
  on a free Kaggle GPU. That is the one step I cannot do for you: it needs
  your Kaggle account with GPU enabled.

The honest metric: note F1 on the MAESTRO test split. Kong's published
number is ~0.939. Our model gets measured against that. No vibes.

## What I need from you

1. Nothing for Track 1, it deploys itself once verified.
2. For Track 2: open kaggle-train.ipynb on Kaggle, enable GPU, run it.
   ~6-10 hours on a free T4. Then we look at the F1 together.

## What you will learn (your rule)

When you are up: spectrograms (sound as an image), the three rolls
(frame/onset/offset) and how they become notes, what quantization actually
does to a model, and how training on MAESTRO works. One concept at a time,
your pace. The quiz at 9pm will cover tonight's material.
