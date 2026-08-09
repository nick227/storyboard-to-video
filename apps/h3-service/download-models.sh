#!/usr/bin/env bash
# Download Comfy-Org MiniMax H3 FL2VA pruned packs into a ComfyUI models tree.
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/home/administrator/web/ComfyUI}"
MODELS_DIR="${H3_MODELS_DIR:-$(cd "$(dirname "$0")" && pwd)/models}"
BASE_URL="${H3_MODEL_BASE_URL:-https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main}"
TOKEN_FILE="${HF_TOKEN_FILE:-$HOME/.cache/huggingface/token}"

AUTH=()
if [[ -n "${HF_TOKEN:-}" ]]; then
  AUTH=(-H "Authorization: Bearer ${HF_TOKEN}")
elif [[ -f "$TOKEN_FILE" ]]; then
  AUTH=(-H "Authorization: Bearer $(tr -d '\n' < "$TOKEN_FILE")")
fi

mkdir -p "$MODELS_DIR/diffusion_models" "$MODELS_DIR/text_encoders" "$MODELS_DIR/vae"

download() {
  local rel="$1"
  local dest="$MODELS_DIR/$rel"
  echo "→ $rel"
  curl -L --retry 30 --retry-delay 5 -C - "${AUTH[@]}" -o "$dest" "$BASE_URL/$rel"
  echo "✓ $rel ($(du -h "$dest" | cut -f1))"
}

download diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors
download text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors
download vae/minimax_h3_video_vae_fp16.safetensors
download vae/minimax_h3_audio_vae_fp32.safetensors

echo "All MiniMax H3 FL2VA packs present under $MODELS_DIR"
