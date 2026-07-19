"""Mocked tests for the alignment-service FastAPI app -- no real wav2vec2 model, no GPU.

ALIGN_SKIP_MODEL_LOAD=1 must be set before `main` is imported so module import never tries to
load the real align model (see main.py's `load_align_model`/`ALIGN_SKIP_MODEL_LOAD`).
`main.align_model`/`main.align_metadata` are monkeypatched with fakes right after import, and
`whisperx.load_audio`/`whisperx.align` (imported lazily inside main.align_audio) are monkeypatched
directly on the `whisperx` module so /align never touches torch/CUDA or the real wav2vec2 model.
"""

import os

os.environ["ALIGN_SKIP_MODEL_LOAD"] = "1"
os.environ["ALIGNMENT_SERVICE_TOKEN"] = "test-token"

import main  # noqa: E402
import whisperx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}


def make_client(monkeypatch):
    main.align_model = object()
    main.align_metadata = {"language": "en", "dictionary": {}, "type": "torchaudio"}
    main.SERVICE_TOKEN = "test-token"
    monkeypatch.setattr(whisperx, "load_audio", lambda path: [0.0] * 16000)
    monkeypatch.setattr(
        whisperx,
        "align",
        lambda segments, model, metadata, audio, device: {
            "word_segments": [
                {"word": "Hello", "start": 0.0, "end": 0.4, "score": 0.9},
                {"word": "world", "start": 0.4, "end": 0.9, "score": 0.85},
            ]
        },
    )
    return TestClient(main.app)


def test_health_requires_no_auth(monkeypatch):
    client = make_client(monkeypatch)
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["modelLoaded"] is True


def test_align_requires_auth(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post("/align", files={"audio": ("clip.wav", b"fake-bytes", "audio/wav")}, data={"transcript": "Hello world"})
    assert response.status_code == 401
    response = client.post(
        "/align",
        headers={"Authorization": "Bearer wrong"},
        files={"audio": ("clip.wav", b"fake-bytes", "audio/wav")},
        data={"transcript": "Hello world"},
    )
    assert response.status_code == 401


def test_align_rejects_empty_transcript(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post("/align", headers=AUTH, files={"audio": ("clip.wav", b"fake-bytes", "audio/wav")}, data={"transcript": "   "})
    assert response.status_code == 400


def test_align_rejects_empty_audio(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post("/align", headers=AUTH, files={"audio": ("clip.wav", b"", "audio/wav")}, data={"transcript": "Hello world"})
    assert response.status_code == 400


def test_align_happy_path_round_trip(monkeypatch):
    client = make_client(monkeypatch)
    response = client.post("/align", headers=AUTH, files={"audio": ("clip.wav", b"fake-bytes", "audio/wav")}, data={"transcript": "Hello world"})
    assert response.status_code == 200
    body = response.json()
    assert body["durationSec"] == 1.0
    assert body["words"] == [
        {"text": "Hello", "start": 0.0, "end": 0.4, "score": 0.9},
        {"text": "world", "start": 0.4, "end": 0.9, "score": 0.85},
    ]


def test_align_drops_words_whisperx_could_not_time(monkeypatch):
    # whisperx omits "start"/"end" entirely (rather than null) for a word it couldn't confidently
    # place -- e.g. a clipped/mumbled token -- see whisperx/alignment.py's word_segment assembly.
    # Those must not reach the client as {start: null, end: null}.
    client = make_client(monkeypatch)
    monkeypatch.setattr(
        whisperx,
        "align",
        lambda segments, model, metadata, audio, device: {
            "word_segments": [
                {"word": "Hello", "start": 0.0, "end": 0.4, "score": 0.9},
                {"word": "mumble"},
                {"word": "world", "start": 0.4, "end": 0.9, "score": 0.85},
            ]
        },
    )
    response = client.post("/align", headers=AUTH, files={"audio": ("clip.wav", b"fake-bytes", "audio/wav")}, data={"transcript": "Hello mumble world"})
    assert response.status_code == 200
    words = response.json()["words"]
    assert [w["text"] for w in words] == ["Hello", "world"]
