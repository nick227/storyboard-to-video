import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import soundfile as sf
import torch
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT / "spark_tts_src"))

from cli.SparkTTS import SparkTTS  # noqa: E402

MODEL_DIR = ROOT / "pretrained_models" / "Spark-TTS-0.5B"
VOICES_DIR = ROOT / "voices"
VOICES_DIR.mkdir(parents=True, exist_ok=True)

device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")


def load_model():
    print(f"Loading Spark-TTS model onto {device} ...", flush=True)
    loaded = SparkTTS(MODEL_DIR, device=device)
    print("Spark-TTS model loaded and ready.", flush=True)
    return loaded


# SPARK_SKIP_MODEL_LOAD lets tests/CI import this module without pulling in the real
# ~4GB model. Production/Modal/local dev never set it, so the model loads eagerly at
# boot exactly as before -- this only exists as a test escape hatch.
model = None if os.environ.get("SPARK_SKIP_MODEL_LOAD") == "1" else load_model()

# Empirically tuned defaults are the library's own (0.8/50/0.95); exposed as env vars so
# quality/consistency can be tuned per deployment without a code change.
INFERENCE_TEMPERATURE = float(os.environ.get("SPARK_TEMPERATURE", 0.8))
INFERENCE_TOP_K = int(os.environ.get("SPARK_TOP_K", 50))
INFERENCE_TOP_P = float(os.environ.get("SPARK_TOP_P", 0.95))

SERVICE_TOKEN = os.environ.get("SPARK_SERVICE_TOKEN", "")
if not SERVICE_TOKEN:
    print("WARNING: SPARK_SERVICE_TOKEN is not set. Every endpoint except /health is unauthenticated. "
          "Fine for local dev, never acceptable for a real deployment.", flush=True)

# Modal injects these so Volume writes survive container recycle (commit) and so this
# container sees clones from other containers (reload). Local uvicorn leaves them None.
_voices_volume_commit = None
_voices_volume_reload = None


def set_voices_volume_hooks(*, commit=None, reload=None):
    global _voices_volume_commit, _voices_volume_reload
    _voices_volume_commit = commit
    _voices_volume_reload = reload


def commit_voices_volume():
    if _voices_volume_commit:
        _voices_volume_commit()


def reload_voices_volume():
    if _voices_volume_reload:
        _voices_volume_reload()


def require_service_token(authorization: str = Header(default="")):
    """Applied to every route except /health. Skipped entirely (no-op) when SPARK_SERVICE_TOKEN
    isn't configured, so local dev keeps working without a token -- Modal/production deploys
    always set it via a secret, so this only ever no-ops locally."""
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")


app = FastAPI()


def slugify(text):
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return slug[:60] or "voice"


def voice_dir(voice_id):
    return VOICES_DIR / voice_id


def load_voice_meta(voice_id):
    meta_path = voice_dir(voice_id) / "meta.json"
    if not meta_path.exists():
        return None
    return json.loads(meta_path.read_text())


def list_voices():
    voices = []
    for entry in sorted(VOICES_DIR.iterdir()) if VOICES_DIR.exists() else []:
        meta_path = entry / "meta.json"
        if meta_path.exists():
            voices.append(json.loads(meta_path.read_text()))
    return voices


# Trims only true leading/trailing silence (never internal pauses): trim-from-start,
# reverse, trim-from-start again (now the original end), reverse back. A single
# silenceremove(stop_periods=...) call is NOT safe here -- it treats the first mid-speech
# pause as "the end" and can discard most of the actual recording (verified empirically:
# it cut a 9.95s real speech sample down to 1.57s).
SILENCE_TRIM_FILTER = (
    "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.2:detection=peak,areverse,"
    "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.2:detection=peak,areverse"
)


def convert_to_reference_wav(raw_bytes, suffix, destination):
    """Normalize whatever the browser recorded (commonly webm/opus) into a clean mono 16kHz WAV via ffmpeg,
    trimming leading/trailing silence so the cloned voice's speaker embedding isn't diluted by dead air."""
    tmp_input = destination.with_name(f"upload{suffix or '.webm'}")
    tmp_input.write_bytes(raw_bytes)
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", str(tmp_input), "-af", SILENCE_TRIM_FILTER, "-ac", "1", "-ar", "16000", str(destination)],
            capture_output=True,
        )
        if result.returncode != 0:
            raise HTTPException(400, f"Could not decode uploaded audio: {result.stderr.decode('utf-8', 'ignore')[:300]}")
    finally:
        tmp_input.unlink(missing_ok=True)


class SynthesizeRequest(BaseModel):
    text: str
    voiceId: str


@app.get("/health")
def health():
    return {"ok": True, "device": str(device)}


@app.get("/voices", dependencies=[Depends(require_service_token)])
def get_voices():
    reload_voices_volume()
    return {"voices": list_voices()}


@app.post("/voices", dependencies=[Depends(require_service_token)])
async def create_voice(audio: UploadFile = File(...), name: str = Form(...)):
    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "Empty audio upload")
    if not name or not name.strip():
        raise HTTPException(400, "name is required")

    short_hash = hashlib.sha1(raw).hexdigest()[:8]
    voice_id = f"{slugify(name)}-{short_hash}"
    target_dir = voice_dir(voice_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    reference_path = target_dir / "reference.wav"

    suffix = Path(audio.filename or "").suffix
    convert_to_reference_wav(raw, suffix, reference_path)

    meta = {
        "voiceId": voice_id,
        "name": name.strip(),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (target_dir / "meta.json").write_text(json.dumps(meta))
    commit_voices_volume()
    return meta


@app.get("/voices/{voice_id}/reference", dependencies=[Depends(require_service_token)])
def get_voice_reference(voice_id: str):
    reload_voices_volume()
    reference_path = voice_dir(voice_id) / "reference.wav"
    if not load_voice_meta(voice_id) or not reference_path.exists():
        raise HTTPException(404, f"Unknown voiceId: {voice_id}")
    return Response(content=reference_path.read_bytes(), media_type="audio/wav")


@app.delete("/voices/{voice_id}", dependencies=[Depends(require_service_token)])
def delete_voice(voice_id: str):
    reload_voices_volume()
    target_dir = voice_dir(voice_id)
    if not load_voice_meta(voice_id):
        raise HTTPException(404, f"Unknown voiceId: {voice_id}")
    shutil.rmtree(target_dir)
    commit_voices_volume()
    return {"ok": True, "voiceId": voice_id}


@app.post("/synthesize", dependencies=[Depends(require_service_token)])
def synthesize(payload: SynthesizeRequest):
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "text is required")
    if model is None:
        raise HTTPException(503, "Model is not loaded")

    reload_voices_volume()
    meta = load_voice_meta(payload.voiceId)
    reference_path = voice_dir(payload.voiceId) / "reference.wav"
    if not meta or not reference_path.exists():
        raise HTTPException(404, f"Unknown voiceId: {payload.voiceId}")

    with torch.no_grad():
        wav = model.inference(
            text,
            str(reference_path),
            temperature=INFERENCE_TEMPERATURE,
            top_k=INFERENCE_TOP_K,
            top_p=INFERENCE_TOP_P,
        )

    buffer = io.BytesIO()
    sf.write(buffer, wav, samplerate=model.sample_rate, format="WAV", subtype="PCM_16")
    return Response(content=buffer.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("VOICE_SERVICE_PORT", 8001)))
