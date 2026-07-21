"""Piper neural TTS HTTP service (local + Modal).

Returns 16-bit mono WAV at Piper's native 22050 Hz for medium-quality voices.
"""

import os
import subprocess
import wave
from io import BytesIO
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

SAMPLE_RATE = 22050
DEFAULT_VOICES = (
    "en_US-lessac-medium,en_US-amy-medium,en_US-ryan-medium,"
    "en_US-hfc_female-medium,en_US-hfc_male-medium,"
    "en_GB-alan-medium,en_GB-jenny_dioco-medium"
)

PIPER_BINARY = Path(os.environ.get("PIPER_BINARY_PATH") or (ROOT / "vendor" / "piper" / "piper"))
VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR") or (ROOT / "vendor" / "piper" / "voices"))
VOICE_IDS = [v.strip() for v in os.environ.get("PIPER_VOICE_IDS", DEFAULT_VOICES).split(",") if v.strip()]

SERVICE_TOKEN = os.environ.get("PIPER_SERVICE_TOKEN", "")
if not SERVICE_TOKEN:
    print("WARNING: PIPER_SERVICE_TOKEN is not set. Every endpoint except /health is unauthenticated. "
          "Fine for local dev, never acceptable for a real deployment.", flush=True)

app = FastAPI()


def require_service_token(authorization: str = Header(default="")):
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")


class SynthesizeRequest(BaseModel):
    text: str
    voiceId: str


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buffer.getvalue()


def synthesize_pcm(text: str, voice_id: str) -> bytes:
    if voice_id not in VOICE_IDS:
        raise HTTPException(404, f"Unknown voiceId: {voice_id}")
    model = VOICES_DIR / f"{voice_id}.onnx"
    if not PIPER_BINARY.is_file() or not model.is_file():
        raise HTTPException(503, "Piper binary or voice model is not installed")
    result = subprocess.run(
        [str(PIPER_BINARY), "--model", str(model), "--output-raw"],
        input=text.encode("utf-8"),
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "ignore").strip()[:300]
        raise HTTPException(500, f"Piper failed ({result.returncode}): {detail}")
    return result.stdout


@app.get("/health")
def health():
    return {
        "ok": True,
        "voices": len(VOICE_IDS),
        "binary": PIPER_BINARY.is_file(),
    }


@app.get("/voices", dependencies=[Depends(require_service_token)])
def list_voices():
    return {"voices": [{"voiceId": voice_id, "label": voice_id} for voice_id in VOICE_IDS]}


@app.post("/synthesize", dependencies=[Depends(require_service_token)])
def synthesize(payload: SynthesizeRequest):
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is required")
    pcm = synthesize_pcm(text, payload.voiceId)
    return Response(content=pcm_to_wav(pcm), media_type="audio/wav")


@app.get("/voices/{voice_id}/preview", dependencies=[Depends(require_service_token)])
def preview(voice_id: str):
    pcm = synthesize_pcm("Hi there! This is a quick preview of this voice.", voice_id)
    return Response(content=pcm_to_wav(pcm), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PIPER_SERVICE_PORT", 8003)))
