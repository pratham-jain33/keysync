#!/usr/bin/env python3
"""Patch Kong's upstream training repo to support our compact model.

Copies ml-quest/conformer2d_compact.py into the repo's models package and
adds a "Conformer2DCompact" branch to get_model() in train.py.

Run from the ml-quest directory:
    python patch_training_repo.py /path/to/piano_transcription
"""
import shutil
import sys
from pathlib import Path

ANCHOR = '''        model = Conformer2D(config)

    elif name == "Conformer2D_nopool":'''

REPLACEMENT = '''        model = Conformer2D(config)

    elif name == "Conformer2DCompact":

        from piano_transcription.models.conformer2d_compact import (
            Conformer2DCompact,
            Conformer2DCompactConfig,
        )

        mconf = configs["model"]
        config = Conformer2DCompactConfig(
            sr=configs["sample_rate"],
            n_fft=mconf["n_fft"],
            hop_length=mconf["hop_length"],
            block_size=mconf.get("block_size", 256),
            enc_layers=mconf.get("enc_layers", 2),
            dec_layers=mconf.get("dec_layers", 2),
            n_head=mconf.get("n_head", 4),
            n_embd=mconf.get("n_embd", 256),
        )

        model = Conformer2DCompact(config)

    elif name == "Conformer2D_nopool":'''


def main() -> None:
    repo = Path(sys.argv[1])
    here = Path(__file__).parent
    dest = repo / "piano_transcription" / "models" / "conformer2d_compact.py"
    shutil.copy(here / "conformer2d_compact.py", dest)
    print(f"copied compact model -> {dest}")

    train_py = repo / "train.py"
    text = train_py.read_text()
    if "Conformer2DCompact" in text:
        print("train.py already patched, skipping")
        return
    assert ANCHOR in text, "anchor not found in train.py; upstream may have changed"
    train_py.write_text(text.replace(ANCHOR, REPLACEMENT))
    print("patched train.py get_model()")


if __name__ == "__main__":
    main()
