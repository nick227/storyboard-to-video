import asyncio
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

import torch  # noqa: E402

device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
LANGUAGE_CODE = os.environ.get("ALIGN_LANGUAGE_CODE", "en")


def load_align_model():
    import whisperx

    print(f"Loading WhisperX align model ({LANGUAGE_CODE}) onto {device} ...", flush=True)
    model, metadata = whisperx.load_align_model(language_code=LANGUAGE_CODE, device=str(device))
    print("WhisperX align model loaded and ready.", flush=True)
    return model, metadata


# ALIGN_SKIP_MODEL_LOAD lets tests/CI import this module without pulling in the real wav2vec2
# align model. Production/local dev never set it, so the model loads eagerly at boot exactly as
# before -- this only exists as a test escape hatch (mirrors voice-service's SPARK_SKIP_MODEL_LOAD).
if os.environ.get("ALIGN_SKIP_MODEL_LOAD") == "1":
    align_model, align_metadata = None, None
else:
    align_model, align_metadata = load_align_model()

SERVICE_TOKEN = os.environ.get("ALIGNMENT_SERVICE_TOKEN", "")
if not SERVICE_TOKEN:
    print("WARNING: ALIGNMENT_SERVICE_TOKEN is not set. Every endpoint except /health is unauthenticated. "
          "Fine for local dev, never acceptable for a real deployment.", flush=True)


def require_service_token(authorization: str = Header(default="")):
    """Applied to every route except /health. Skipped entirely (no-op) when ALIGNMENT_SERVICE_TOKEN
    isn't configured, so local dev keeps working without a token."""
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "device": str(device), "modelLoaded": align_model is not None}


@app.post("/align", dependencies=[Depends(require_service_token)])
async def align_audio(audio: UploadFile = File(...), transcript: str = Form(...)):
    import whisperx
    from whisperx.audio import SAMPLE_RATE

    transcript = transcript.strip()
    if not transcript:
        raise HTTPException(400, "transcript is required")
    if align_model is None:
        raise HTTPException(503, "Align model is not loaded")

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "Empty audio upload")

    suffix = Path(audio.filename or "").suffix or ".wav"
    tmp_path = ROOT / f"upload-{os.getpid()}-{time.time_ns()}{suffix}"
    tmp_path.write_bytes(raw)
    try:
        waveform = await asyncio.to_thread(whisperx.load_audio, str(tmp_path))
    except RuntimeError as error:
        raise HTTPException(400, f"Could not decode uploaded audio: {error}")
    finally:
        tmp_path.unlink(missing_ok=True)

    duration_sec = len(waveform) / SAMPLE_RATE
    # Alignment-only: one segment spanning the whole clip using the caller's exact transcript,
    # instead of running ASR to produce (and possibly mis-transcribe) the segments ourselves.
    segments = [{"text": transcript, "start": 0.0, "end": duration_sec}]
    # whisperx.align is a synchronous CPU/GPU-bound call that can take seconds on longer
    # narration -- run it off the event loop so /health and other concurrent /align calls
    # (e.g. other scenes mid-batch) aren't stalled behind it.
    result = await asyncio.to_thread(whisperx.align, segments, align_model, align_metadata, waveform, str(device))

    # whisperx only sets "start"/"end" on a word once at least one of its characters aligned
    # confidently (see whisperx/alignment.py); a word that never gets one -- e.g. a clipped or
    # mumbled token at a clip boundary -- has no timing at all. Drop those instead of passing
    # {start: null, end: null} downstream, where they'd be unusable for karaoke highlighting.
    words = [
        {"text": word.get("word", ""), "start": word["start"], "end": word["end"], "score": word.get("score")}
        for word in result.get("word_segments", [])
        if "start" in word and "end" in word
    ]
    return {"words": words, "durationSec": duration_sec}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ALIGNMENT_SERVICE_PORT", 8002)))
