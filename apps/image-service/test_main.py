"""Mocked tests for image-service — no torch/SDXL weights required."""

import os

os.environ["IMAGE_SKIP_MODEL_LOAD"] = "1"
os.environ["IMAGE_SERVICE_TOKEN"] = "test-token"

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}
PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00"
    b"\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"
)


def make_client():
    main.SERVICE_TOKEN = "test-token"
    main.pipeline = object()  # truthy so /health reports loaded when we want

    def fake_png(payload):
        assert payload.prompt
        return PNG_1X1

    main.generate_png = fake_png
    return TestClient(main.app)


def test_health_requires_no_auth():
    client = make_client()
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["model"]


def test_protected_routes_reject_missing_or_wrong_token():
    client = make_client()
    assert client.post("/generate", json={"prompt": "hi"}).status_code == 401
    assert client.post(
        "/generate",
        headers={"Authorization": "Bearer wrong"},
        json={"prompt": "hi"},
    ).status_code == 401


def test_generate_requires_prompt():
    client = make_client()
    response = client.post("/generate", headers=AUTH, json={"prompt": "  "})
    assert response.status_code == 400


def test_generate_returns_png():
    client = make_client()
    response = client.post(
        "/generate",
        headers=AUTH,
        json={"prompt": "a red circle", "width": 1024, "height": 768, "steps": 20},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"
