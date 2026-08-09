#!/usr/bin/env bash
# Start ComfyUI (8188) then the H3 FastAPI sidecar (8010).
set -euo pipefail

COMFY_ROOT="${COMFY_ROOT:-/home/administrator/web/ComfyUI}"
SERVICE_ROOT="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -x "$COMFY_ROOT/.venv/bin/python" ]]; then
  echo "ComfyUI venv missing at $COMFY_ROOT/.venv — create it and pip install -r requirements.txt" >&2
  exit 1
fi

mkdir -p "$SERVICE_ROOT/io"
export H3_SHARED_DIR="${H3_SHARED_DIR:-$SERVICE_ROOT/io}"
export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
export COMFY_INPUT_DIR="${COMFY_INPUT_DIR:-$COMFY_ROOT/input}"
export COMFY_OUTPUT_DIR="${COMFY_OUTPUT_DIR:-$COMFY_ROOT/output}"
export COMFY_MODELS_DIR="${COMFY_MODELS_DIR:-$SERVICE_ROOT/models}"

echo "Starting ComfyUI on :8188 (do not also run LTX on this GPU)..."
(
  cd "$COMFY_ROOT"
  # --disable-pinned-memory keeps host RAM pressure lower on 32GB / 12GB VRAM boxes.
  exec .venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory
) &
COMFY_PID=$!

cleanup() {
  kill "$COMFY_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "Waiting for ComfyUI..."
for _ in $(seq 1 60); do
  if curl -sf "$COMFY_URL/system_stats" >/dev/null; then
    break
  fi
  sleep 2
done

cd "$SERVICE_ROOT"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

echo "Starting H3 sidecar on :8010..."
exec .venv/bin/python main.py
