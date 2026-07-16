"""Mocked tests for the voice-service FastAPI app -- no real model, no GPU, no network.

SPARK_SKIP_MODEL_LOAD=1 must be set before `main` is imported so module import never
tries to load the real ~4GB Spark-TTS model (see main.py's `load_model`/`SPARK_SKIP_MODEL_LOAD`).
`main.model` is monkeypatched with a fake object right after import so /synthesize has
something to call without touching torch/CUDA at all.
"""

import io
import os
import wave

os.environ["SPARK_SKIP_MODEL_LOAD"] = "1"
os.environ["SPARK_SERVICE_TOKEN"] = "test-token"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}


class FakeModel:
    sample_rate = 16000

    def inference(self, text, prompt_speech_path, **kwargs):
        import numpy as np

        return np.zeros(int(self.sample_rate * 0.2), dtype="float32")


def make_client():
    main.model = FakeModel()
    main.SERVICE_TOKEN = "test-token"
    return TestClient(main.app)


def tiny_wav_bytes(seconds=0.5, rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(rate)
        wav_file.writeframes(b"\x00\x00" * int(rate * seconds))
    return buffer.getvalue()


def test_health_requires_no_auth():
    client = make_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_protected_routes_reject_missing_or_wrong_token():
    client = make_client()
    assert client.get("/voices").status_code == 401
    assert client.get("/voices", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/voices", headers=AUTH).status_code == 200


def test_synthesize_unknown_voice_is_404():
    client = make_client()
    response = client.post("/synthesize", headers=AUTH, json={"text": "hi", "voiceId": "nonexistent"})
    assert response.status_code == 404


def test_delete_unknown_voice_is_404():
    client = make_client()
    response = client.delete("/voices/nonexistent", headers=AUTH)
    assert response.status_code == 404


def test_clone_synthesize_reference_delete_lifecycle():
    client = make_client()

    create_response = client.post(
        "/voices",
        headers=AUTH,
        files={"audio": ("sample.wav", tiny_wav_bytes(), "audio/wav")},
        data={"name": "Test Lifecycle Voice"},
    )
    assert create_response.status_code == 200
    voice_id = create_response.json()["voiceId"]

    # Reference clip: 401 without token, 200 with it.
    assert client.get(f"/voices/{voice_id}/reference").status_code == 401
    reference_response = client.get(f"/voices/{voice_id}/reference", headers=AUTH)
    assert reference_response.status_code == 200
    assert reference_response.headers["content-type"] == "audio/wav"

    # Synthesize with the mocked model.
    synth_response = client.post("/synthesize", headers=AUTH, json={"text": "Hello world.", "voiceId": voice_id})
    assert synth_response.status_code == 200
    assert synth_response.headers["content-type"] == "audio/wav"
    assert len(synth_response.content) > 44  # more than just a WAV header

    # Appears in the list.
    voices = client.get("/voices", headers=AUTH).json()["voices"]
    assert any(v["voiceId"] == voice_id for v in voices)

    # Delete, then confirm it's really gone.
    delete_response = client.delete(f"/voices/{voice_id}", headers=AUTH)
    assert delete_response.status_code == 200
    assert client.get(f"/voices/{voice_id}/reference", headers=AUTH).status_code == 404
    assert client.post("/synthesize", headers=AUTH, json={"text": "hi", "voiceId": voice_id}).status_code == 404
