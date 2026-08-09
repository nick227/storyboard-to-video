#!/usr/bin/env bash
# Smoke: generate one short I2V clip via the H3 sidecar (requires ComfyUI + weights).
set -euo pipefail

SERVICE_ROOT="$(cd "$(dirname "$0")" && pwd)"
SHARED="${H3_SHARED_DIR:-$SERVICE_ROOT/io}"
H3_URL="${H3_VIDEO_URL:-http://127.0.0.1:8010}"
IMAGE="${1:-}"
mkdir -p "$SHARED"

if [[ -z "$IMAGE" ]]; then
  IMAGE="$SHARED/smoke-start.png"
  python3 - <<'PY'
from pathlib import Path
try:
    from PIL import Image, ImageDraw
except ImportError:
    import struct, zlib
    # Minimal 64x64 red PNG without Pillow
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes([255,0,0])*64 for _ in range(64))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 64, 64, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    Path("/home/administrator/web/basic-cartoon-poc/apps/h3-service/io/smoke-start.png").write_bytes(png)
    raise SystemExit
img = Image.new('RGB', (864, 480), (32, 64, 120))
d = ImageDraw.Draw(img)
d.ellipse((300, 120, 560, 360), fill=(220, 180, 90))
img.save(Path("/home/administrator/web/basic-cartoon-poc/apps/h3-service/io/smoke-start.png"))
PY
fi

OUT="$SHARED/smoke-h3.mp4"
echo "Preflight..."
curl -sf "$H3_URL/ready" | tee /tmp/h3-smoke-ready.json
echo
echo "Generating (draft 864x480, 5s) — expect several minutes on a 3060..."
START=$(date +%s)
curl -sf -X POST "$H3_URL/generate" \
  -H 'Content-Type: application/json' \
  -d "{\"prompt\":\"Gentle camera push-in on the character. Soft ambient room tone.\",\"image\":\"$IMAGE\",\"width\":864,\"height\":480,\"duration\":5,\"steps\":20,\"seed\":42,\"output\":\"$OUT\"}" \
  | tee /tmp/h3-smoke-generate.json
END=$(date +%s)
echo
ls -lh "$OUT"
echo "elapsed_s=$((END-START))"
