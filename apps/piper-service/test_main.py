"""Mocked tests for piper-service — no real Piper binary required."""

import io
import os
import wave

os.environ["PIPER_SERVICE_TOKEN"] = "test-token"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}


def make_client(monkeypatch=None):
    main.SERVICE_TOKEN = "test-token"
    main.VOICE_IDS = ["en_US-lessac-medium"]

    def fake_pcm(text, voice_id):
        if voice_id not in main.VOICE_IDS:
            from fastapi import HTTPException

            raise HTTPException(404, f"Unknown voiceId: {voice_id}")
        # 0.1s of silence at 22050 Hz, 16-bit mono
        return b"\x00\x00" * int(22050 * 0.1)

    main.synthesize_pcm = fake_pcm
    return TestClient(main.app)


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
    response = client.post("/synthesize", headers=AUTH, json={"text": "hi", "voiceId": "missing"})
    assert response.status_code == 404


def test_synthesize_returns_wav():
    client = make_client()
    response = client.post(
        "/synthesize",
        headers=AUTH,
        json={"text": "hello", "voiceId": "en_US-lessac-medium"},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("audio/wav")
    with wave.open(io.BytesIO(response.content), "rb") as wav_file:
        assert wav_file.getnchannels() == 1
        assert wav_file.getframerate() == 22050
