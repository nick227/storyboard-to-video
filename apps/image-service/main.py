"""SDXL text-to-image HTTP service (local + Modal).

Returns a PNG body. Model weights load from IMAGE_MODEL_DIR (Modal image build
downloads them) or Hugging Face on first local boot. Set IMAGE_SKIP_MODEL_LOAD=1
in CI so tests can import without torch/diffusers/weights.
"""

import io
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

MODEL_ID = os.environ.get("IMAGE_MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
MODEL_DIR = Path(os.environ.get("IMAGE_MODEL_DIR", str(ROOT / "models" / "sdxl-base")))
DEFAULT_STEPS = int(os.environ.get("IMAGE_DEFAULT_STEPS", "30"))
DEFAULT_GUIDANCE = float(os.environ.get("IMAGE_DEFAULT_GUIDANCE", "5.0"))

SERVICE_TOKEN = os.environ.get("IMAGE_SERVICE_TOKEN", "")
if not SERVICE_TOKEN:
    print(
        "WARNING: IMAGE_SERVICE_TOKEN is not set. Every endpoint except /health is unauthenticated. "
        "Fine for local dev, never acceptable for a real deployment.",
        flush=True,
    )


def load_pipeline():
    import torch
    from diffusers import StableDiffusionXLPipeline

    source = str(MODEL_DIR) if (MODEL_DIR / "model_index.json").is_file() else MODEL_ID
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    print(f"Loading SDXL from {source} ({dtype}) ...", flush=True)
    kwargs = {"torch_dtype": dtype, "use_safetensors": True}
    if dtype == torch.float16:
        kwargs["variant"] = "fp16"
    pipe = StableDiffusionXLPipeline.from_pretrained(source, **kwargs)
    if torch.cuda.is_available():
        pipe = pipe.to("cuda")
    print("SDXL loaded and ready.", flush=True)
    return pipe


# IMAGE_SKIP_MODEL_LOAD is a CI/test escape hatch only — production/Modal never set it.
pipeline = None if os.environ.get("IMAGE_SKIP_MODEL_LOAD") == "1" else load_pipeline()

app = FastAPI()


def require_service_token(authorization: str = Header(default="")):
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(401, "Unauthorized")


class GenerateRequest(BaseModel):
    prompt: str
    negativePrompt: str = ""
    width: int = Field(default=1024, ge=512, le=1536)
    height: int = Field(default=1024, ge=512, le=1536)
    steps: int = Field(default=DEFAULT_STEPS, ge=1, le=50)
    guidance: float = Field(default=DEFAULT_GUIDANCE, ge=0, le=20)


def generate_png(payload: GenerateRequest) -> bytes:
    if pipeline is None:
        raise HTTPException(503, "Image model is not loaded")
    # Snap to multiples of 8 — SDXL UNet requirement.
    width = max(512, min(1536, (payload.width // 8) * 8))
    height = max(512, min(1536, (payload.height // 8) * 8))
    result = pipeline(
        prompt=payload.prompt,
        negative_prompt=payload.negativePrompt or None,
        width=width,
        height=height,
        num_inference_steps=payload.steps,
        guidance_scale=payload.guidance,
    )
    image = result.images[0]
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_ID,
        "loaded": pipeline is not None,
        "cuda": bool(os.environ.get("IMAGE_SKIP_MODEL_LOAD") != "1" and _cuda_available()),
    }


def _cuda_available():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


@app.post("/generate", dependencies=[Depends(require_service_token)])
def generate(payload: GenerateRequest):
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
    return Response(content=generate_png(payload), media_type="image/png")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("IMAGE_SERVICE_PORT", 8004)))
