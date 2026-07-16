"""Modal deployment definition for the voice-cloning service. NOT deployed by this change --
this file exists so the deploy path is ready; actually running `modal deploy` requires a real
Modal account, a `voice-service-secrets` Secret (SPARK_SERVICE_TOKEN, SPARK_TEMPERATURE,
SPARK_TOP_K, SPARK_TOP_P), and a `voice-service-voices` Volume, none of which exist yet.

Verified against Modal's current docs this session (not guessed): stacking @app.function(...)
with @modal.asgi_app() on a function that returns an existing FastAPI app instance is the
documented pattern for serving a full app (as opposed to @modal.fastapi_endpoint, which is for
a single simple route). gpu=, secrets=, volumes=, timeout=, and min_containers= are real,
current parameters of App.function().

One thing NOT independently verified against a live example: the exact method name
`pip_install_from_requirements` below. It matches Modal's documented API from general
knowledge, but wasn't seen in a fetched code sample this session -- double-check against
https://modal.com/docs/reference/modal.Image before the first real deploy.
"""

import modal

image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg")
    .pip_install_from_requirements("requirements.txt")
    .add_local_dir("spark_tts_src", remote_path="/root/spark_tts_src")
    .add_local_dir("pretrained_models", remote_path="/root/pretrained_models")
    .add_local_file("main.py", remote_path="/root/main.py")
)

app = modal.App("voice-service", image=image)


@app.function(
    gpu="A10G",  # cheap starting point for a 0.5B-parameter model; revisit before a real deploy
    secrets=[modal.Secret.from_name("voice-service-secrets")],
    volumes={"/root/voices": modal.Volume.from_name("voice-service-voices", create_if_missing=True)},
    timeout=600,
    min_containers=0,
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/root")
    from main import app as web_app

    return web_app
