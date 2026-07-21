"""Modal deployment definition for the voice-cloning service.

The image build is fully self-contained -- it does NOT read spark_tts_src/ or
pretrained_models/ off the deploying machine's disk (those directories are gitignored
local artifacts of `setup.sh` and are never present on a fresh checkout, e.g. in CI).
Instead the build itself fetches both from their upstream sources:
  - spark_tts_src is git-cloned from SparkAudio/Spark-TTS, pinned to the exact commit
    this repo's vendored copy was verified against (2f1ea9082400547242641f5271b6f941c9f439d1).
  - pretrained_models/Spark-TTS-0.5B is pulled from the SparkAudio/Spark-TTS-0.5B HF repo
    via huggingface_hub.snapshot_download inside a build step, same model setup.sh downloads
    for local dev.
Modal caches each image layer, so re-deploys only redo these steps when the pin changes.

Before the first real deploy you still need to create, outside this file:
  - a `voice-service-secrets` Modal Secret (SPARK_SERVICE_TOKEN, SPARK_TEMPERATURE,
    SPARK_TOP_K, SPARK_TOP_P)
  - a `voice-service-voices` Modal Volume (create_if_missing=True below handles this)
  - MODAL_TOKEN_ID / MODAL_TOKEN_SECRET as repo secrets for .github/workflows/deploy-modal.yml

Verified against Modal's current docs this session (not guessed): stacking @app.function(...)
with @modal.asgi_app() on a function that returns an existing FastAPI app instance is the
documented pattern for serving a full app (as opposed to @modal.fastapi_endpoint, which is for
a single simple route). gpu=, secrets=, volumes=, timeout=, and min_containers= are real,
current parameters of App.function(). Image.pip_install_from_requirements, Image.run_commands,
and Image.run_function are also confirmed-current methods with the signatures used below.
"""

import modal

SPARK_TTS_COMMIT = "2f1ea9082400547242641f5271b6f941c9f439d1"
SPARK_TTS_REPO_ID = "SparkAudio/Spark-TTS-0.5B"


def download_pretrained_model():
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=SPARK_TTS_REPO_ID,
        local_dir="/root/pretrained_models/Spark-TTS-0.5B",
    )


image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg", "git")
    .pip_install_from_requirements("requirements.txt")
    .run_commands(
        f"git clone https://github.com/SparkAudio/Spark-TTS.git /root/spark_tts_src "
        f"&& cd /root/spark_tts_src && git checkout {SPARK_TTS_COMMIT}"
    )
    .run_function(download_pretrained_model)
    .add_local_file("main.py", remote_path="/root/main.py")
)

app = modal.App("voice-service", image=image)
voices_volume = modal.Volume.from_name("voice-service-voices", create_if_missing=True)


@app.function(
    gpu="A10G",  # cheap starting point for a 0.5B-parameter model; revisit before a real deploy
    secrets=[modal.Secret.from_name("voice-service-secrets")],
    volumes={"/root/voices": voices_volume},
    timeout=600,
    min_containers=0,
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/root")
    from main import app as web_app, set_voices_volume_hooks

    set_voices_volume_hooks(commit=voices_volume.commit, reload=voices_volume.reload)
    return web_app
