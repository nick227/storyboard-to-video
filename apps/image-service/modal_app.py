"""Modal deployment for SDXL image generation.

Image build downloads stabilityai/stable-diffusion-xl-base-1.0 from Hugging Face
(public — no HF_TOKEN required). Same Environment split as voice/piper:
  - `dev` auto-deploy from ci.yml after image-service tests pass on main
  - `prod` manual-only via deploy-modal.yml

One-time setup (see .github/scripts/modal-bootstrap.sh):
  - Modal Environments `dev` / `prod`
  - `image-service-secrets` (IMAGE_SERVICE_TOKEN) in each Environment
  - MODAL_TOKEN_ID / MODAL_TOKEN_SECRET as repo secrets

MODAL_MAX_CONTAINERS defaults to 1 (GPU cost cap). Do not raise without a capacity decision.
"""

import os

import modal

SDXL_REPO_ID = "stabilityai/stable-diffusion-xl-base-1.0"
MAX_CONTAINERS = int(os.environ.get("MODAL_MAX_CONTAINERS", "1"))


def download_sdxl():
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=SDXL_REPO_ID,
        local_dir="/root/models/sdxl-base",
    )


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .pip_install_from_requirements("requirements.txt")
    .env({
        "IMAGE_MODEL_ID": SDXL_REPO_ID,
        "IMAGE_MODEL_DIR": "/root/models/sdxl-base",
    })
    .run_function(download_sdxl)
    .add_local_file("main.py", remote_path="/root/main.py")
)

app = modal.App("image-service", image=image)


@app.function(
    gpu="A10G",
    secrets=[modal.Secret.from_name("image-service-secrets")],
    timeout=600,
    min_containers=0,
    max_containers=MAX_CONTAINERS,
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/root")
    from main import app as web_app

    return web_app
