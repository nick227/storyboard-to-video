"""MiniMax H3 sidecar unit tests — no ComfyUI or weights required."""

import os
from pathlib import Path
from unittest.mock import MagicMock

os.environ["H3_SERVICE_TOKEN"] = "test-token"
os.environ["H3_SHARED_DIR"] = str(Path(__file__).resolve().parent / "io-test")

import frames  # noqa: E402
import main  # noqa: E402
import workflow  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"Authorization": "Bearer test-token"}


def test_align_frame_count_snaps_to_17k_plus_5():
    assert frames.align_frame_count(120) == 124
    assert frames.align_frame_count(124) == 124
    assert frames.align_frame_count(5) == 5


def test_snap_dimensions_multiples_of_32():
    width, height = frames.snap_dimensions(850, 470)
    assert width % 32 == 0
    assert height % 32 == 0


def test_build_fl2va_prompt_wires_first_and_last_frames():
    graph = workflow.build_fl2va_prompt(
        prompt="camera push in",
        width=864,
        height=480,
        length=124,
        seed=7,
        first_frame="start.png",
        last_frame="end.png",
    )
    assert graph["104"]["class_type"] == "MiniMaxH3ImageToVideo"
    assert graph["104"]["inputs"]["first_frame"] == ["114", 0]
    assert graph["104"]["inputs"]["last_frame"] == ["115", 0]
    assert graph["114"]["inputs"]["image"] == "start.png"
    assert graph["92"]["class_type"] == "SaveVideo"


def test_health_requires_no_auth():
    main._client = MagicMock()
    main._client.system_stats.return_value = {"system": {}}
    client = TestClient(main.app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_ready_rejects_wrong_token():
    client = TestClient(main.app)
    response = client.get("/ready")
    assert response.status_code == 401


def test_ready_reports_missing_models(tmp_path, monkeypatch):
    monkeypatch.setenv("COMFY_MODELS_DIR", str(tmp_path))
    main._client = MagicMock()
    main._client.system_stats.return_value = {"system": {}}
    # Re-bind required models lookup via monkeypatch on helper
    monkeypatch.setattr(main, "_models_ready", lambda: (False, ["unet"]))
    client = TestClient(main.app)
    response = client.get("/ready", headers=AUTH)
    assert response.status_code == 503
