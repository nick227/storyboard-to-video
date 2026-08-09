"""MiniMax H3 local video sidecar — drives ComfyUI FL2VA workflows over HTTP.

Contract mirrors LTX: shared-dir staging + blocking /generate. Requires a running
ComfyUI (0.30+) with Comfy-Org MiniMax H3 pruned INT8 packs installed.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from comfy_client import ComfyClient, ComfyClientError
from frames import align_frame_count, snap_dimensions
from workflow import build_fl2va_prompt

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
SERVICE_TOKEN = os.environ.get("H3_SERVICE_TOKEN", "")
SHARED_DIR = Path(os.environ.get("H3_SHARED_DIR", str(ROOT / "io")))
COMFY_MODELS_DIR = Path(os.environ.get("COMFY_MODELS_DIR", str(ROOT / "models")))
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/home/administrator/web/ComfyUI/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/home/administrator/web/ComfyUI/output"))
UNET_NAME = os.environ.get("H3_UNET_NAME", "minimax_h3_fl2va_pruned_int8_convrot.safetensors")
CLIP_NAME = os.environ.get("H3_CLIP_NAME", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors")
VIDEO_VAE_NAME = os.environ.get("H3_VIDEO_VAE_NAME", "minimax_h3_video_vae_fp16.safetensors")
AUDIO_VAE_NAME = os.environ.get("H3_AUDIO_VAE_NAME", "minimax_h3_audio_vae_fp32.safetensors")
DEFAULT_STEPS = int(os.environ.get("H3_DEFAULT_STEPS", "20"))
POLL_INTERVAL_S = float(os.environ.get("H3_POLL_INTERVAL_S", "2"))
GENERATE_TIMEOUT_S = float(os.environ.get("H3_GENERATE_TIMEOUT_S", "1800"))
FPS = 24

SHARED_DIR.mkdir(parents=True, exist_ok=True)

if not SERVICE_TOKEN:
    print(
        "WARNING: H3_SERVICE_TOKEN is not set. Every endpoint except /health is unauthenticated. "
        "Fine for local dev, never acceptable for a real deployment.",
        flush=True,
    )

app = FastAPI(title="MiniMax H3 local video service")
_job_lock = threading.Lock()
_client = ComfyClient(COMFY_URL)


def require_service_token(authorization: str = Header(default="")):
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")


class GenerateRequest(BaseModel):
    prompt: str
    image: Optional[str] = None
    end_image: Optional[str] = None
    width: int = Field(default=864, ge=32, le=1920)
    height: int = Field(default=480, ge=32, le=1920)
    duration: Optional[float] = Field(default=None, ge=1, le=6)
    frames: Optional[int] = Field(default=None, ge=5, le=149)
    steps: int = Field(default=DEFAULT_STEPS, ge=5, le=50)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    output: str


def _required_models() -> dict[str, Path]:
    return {
        "unet": COMFY_MODELS_DIR / "diffusion_models" / UNET_NAME,
        "clip": COMFY_MODELS_DIR / "text_encoders" / CLIP_NAME,
        "video_vae": COMFY_MODELS_DIR / "vae" / VIDEO_VAE_NAME,
        "audio_vae": COMFY_MODELS_DIR / "vae" / AUDIO_VAE_NAME,
    }


def _models_ready() -> tuple[bool, list[str]]:
    missing = [name for name, path in _required_models().items() if not path.is_file() or path.stat().st_size < 1_000_000]
    return (not missing, missing)


def _resolve_shared(path_str: str) -> Path:
    path = Path(path_str).resolve()
    shared = SHARED_DIR.resolve()
    if shared not in path.parents and path != shared:
        # Allow files already under shared or exact shared children only.
        try:
            path.relative_to(shared)
        except ValueError as exc:
            raise HTTPException(400, f"Path must be under H3_SHARED_DIR ({shared}): {path}") from exc
    return path


def _stage_into_comfy_input(source: Path, prefix: str) -> str:
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest_name = f"{prefix}-{source.name}"
    dest = COMFY_INPUT_DIR / dest_name
    shutil.copy2(source, dest)
    return dest_name


def _wait_for_video(prompt_id: str, timeout_s: float) -> Path:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        history = _client.history(prompt_id)
        entry = history.get(prompt_id)
        if entry:
            status = entry.get("status") or {}
            if status.get("status_str") == "error" or status.get("completed") is False and status.get("messages"):
                raise HTTPException(500, f"ComfyUI job failed: {status}")
            outputs = entry.get("outputs") or {}
            for node_out in outputs.values():
                for video in node_out.get("videos") or node_out.get("gifs") or []:
                    filename = video.get("filename")
                    if not filename:
                        continue
                    subfolder = video.get("subfolder") or ""
                    candidate = COMFY_OUTPUT_DIR / subfolder / filename if subfolder else COMFY_OUTPUT_DIR / filename
                    if candidate.is_file():
                        return candidate
            # Some SaveVideo builds report under images with video mime — fall through to scan.
            prefix = f"h3-{prompt_id}"
            matches = sorted(COMFY_OUTPUT_DIR.rglob(f"{prefix}*"), key=lambda p: p.stat().st_mtime, reverse=True)
            for match in matches:
                if match.suffix.lower() in {".mp4", ".webm", ".mkv"}:
                    return match
        time.sleep(POLL_INTERVAL_S)
    raise HTTPException(504, f"ComfyUI job timed out after {timeout_s:.0f}s")


@app.get("/health")
def health():
    models_ok, missing = _models_ready()
    comfy_ok = False
    try:
        comfy_ok = _client.system_stats() is not None
    except ComfyClientError:
        comfy_ok = False
    return {
        "ok": True,
        "comfy": comfy_ok,
        "models": models_ok,
        "missing_models": missing,
        "unet": UNET_NAME,
    }


@app.get("/ready")
def ready(_: Any = Depends(require_service_token)):
    models_ok, missing = _models_ready()
    try:
        _client.system_stats()
    except ComfyClientError as exc:
        raise HTTPException(
            503,
            detail={"code": "NOT_READY", "message": f"ComfyUI unavailable: {exc}", "retryable": True},
        ) from exc
    if not models_ok:
        raise HTTPException(
            503,
            detail={
                "code": "NOT_READY",
                "message": f"Missing MiniMax H3 model files: {', '.join(missing)}",
                "retryable": True,
            },
        )
    return {"ok": True, "provider": "minimax-h3", "model": "minimax-h3-fl2va"}


@app.post("/generate")
def generate(payload: GenerateRequest, _: Any = Depends(require_service_token)):
    if not _job_lock.acquire(blocking=False):
        raise HTTPException(
            409,
            detail={"code": "BUSY", "message": "MiniMax H3 is already generating a clip", "retryable": True},
        )
    staged: list[Path] = []
    try:
        ready()
        width, height = snap_dimensions(payload.width, payload.height)
        if payload.frames is not None:
            length = align_frame_count(payload.frames)
        else:
            seconds = payload.duration if payload.duration is not None else 5.0
            length = align_frame_count(max(5, round(seconds * FPS)))
        if length > 149:
            raise HTTPException(400, "Duration exceeds local MiniMax H3 cap (~6s)")

        output_path = Path(payload.output)
        if not output_path.is_absolute():
            output_path = SHARED_DIR / output_path
        output_path = output_path.resolve()
        try:
            output_path.relative_to(SHARED_DIR.resolve())
        except ValueError as exc:
            raise HTTPException(400, f"output must be under H3_SHARED_DIR ({SHARED_DIR})") from exc
        output_path.parent.mkdir(parents=True, exist_ok=True)

        job_id = uuid.uuid4().hex[:12]
        first_name = None
        last_name = None
        if payload.image:
            image_path = _resolve_shared(payload.image) if not Path(payload.image).is_absolute() else Path(payload.image).resolve()
            if not image_path.is_file():
                raise HTTPException(400, f"image not found: {image_path}")
            first_name = _stage_into_comfy_input(image_path, f"h3-{job_id}-start")
            staged.append(COMFY_INPUT_DIR / first_name)
        if payload.end_image:
            end_path = _resolve_shared(payload.end_image) if not Path(payload.end_image).is_absolute() else Path(payload.end_image).resolve()
            if not end_path.is_file():
                raise HTTPException(400, f"end_image not found: {end_path}")
            last_name = _stage_into_comfy_input(end_path, f"h3-{job_id}-end")
            staged.append(COMFY_INPUT_DIR / last_name)

        filename_prefix = f"h3-{job_id}"
        prompt_graph = build_fl2va_prompt(
            prompt=payload.prompt,
            width=width,
            height=height,
            length=length,
            seed=payload.seed,
            steps=payload.steps,
            first_frame=first_name,
            last_frame=last_name,
            filename_prefix=filename_prefix,
            unet_name=UNET_NAME,
            clip_name=CLIP_NAME,
            video_vae_name=VIDEO_VAE_NAME,
            audio_vae_name=AUDIO_VAE_NAME,
        )
        prompt_id = _client.queue_prompt(prompt_graph)
        video_path = _wait_for_video(prompt_id, GENERATE_TIMEOUT_S)
        shutil.copy2(video_path, output_path)
        return {
            "ok": True,
            "provider": "minimax-h3",
            "model": "minimax-h3-fl2va",
            "output": str(output_path),
            "prompt_id": prompt_id,
            "usage": {
                "videos": 1,
                "frames": length,
                "frameRate": FPS,
                "seconds": length / FPS,
                "steps": payload.steps,
                "width": width,
                "height": height,
            },
        }
    finally:
        for path in staged:
            path.unlink(missing_ok=True)
        _job_lock.release()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.environ.get("H3_HOST", "0.0.0.0"),
        port=int(os.environ.get("H3_PORT", "8010")),
        reload=False,
    )
