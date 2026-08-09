#!/usr/bin/env python3
"""Download remaining MiniMax H3 FL2VA packs into apps/h3-service/models."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("H3_MODELS_DIR", ROOT / "models"))
REPO = "Comfy-Org/MiniMax-H3"
FILES = [
    "vae/minimax_h3_audio_vae_fp32.safetensors",
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
]


def place(cached: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        dest.unlink()
    try:
        os.link(cached, dest)
    except OSError as exc:
        print(f"link failed ({exc}); copying", flush=True)
        shutil.copy2(cached, dest)


def main() -> None:
    token = os.environ.get("HF_TOKEN") or None
    for rel in FILES:
        dest = MODELS / rel
        if dest.is_file() and dest.stat().st_size > 100_000_000:
            print(f"SKIP {rel} ({dest.stat().st_size})", flush=True)
            continue
        print(f"START {rel}", flush=True)
        cached = Path(hf_hub_download(repo_id=REPO, filename=rel, token=token)).resolve()
        print(f"CACHED {cached} ({cached.stat().st_size})", flush=True)
        place(cached, dest)
        print(f"DONE {dest} ({dest.stat().st_size})", flush=True)
    print("ALL_DONE", flush=True)


if __name__ == "__main__":
    main()
