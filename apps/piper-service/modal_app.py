"""Modal deployment for Piper TTS.

Image build downloads the Piper linux x86_64 release and the curated voice models
from Hugging Face (same pins as apps/web/scripts/setup-piper.js). No local vendor/
tree is required on the deploying machine.
"""

import modal

PIPER_RELEASE_URL = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
VOICE_IDS = [
    "en_US-lessac-medium",
    "en_US-amy-medium",
    "en_US-ryan-medium",
    "en_US-hfc_female-medium",
    "en_US-hfc_male-medium",
    "en_GB-alan-medium",
    "en_GB-jenny_dioco-medium",
]


def piper_voice_urls(voice_id: str):
    locale, speaker, quality = voice_id.split("-")
    lang = locale.split("_")[0]
    base = (
        f"https://huggingface.co/rhasspy/piper-voices/resolve/main/"
        f"{lang}/{locale}/{speaker}/{quality}/{voice_id}"
    )
    return f"{base}.onnx", f"{base}.onnx.json"


def install_piper_and_voices():
    import tarfile
    import urllib.request
    from pathlib import Path

    root = Path("/root/piper")
    tar_path = Path("/tmp/piper.tar.gz")
    urllib.request.urlretrieve(PIPER_RELEASE_URL, tar_path)
    with tarfile.open(tar_path, "r:gz") as archive:
        archive.extractall("/root")
    binary = root / "piper"
    binary.chmod(0o755)
    voices = root / "voices"
    voices.mkdir(parents=True, exist_ok=True)
    for voice_id in VOICE_IDS:
        onnx_url, config_url = piper_voice_urls(voice_id)
        urllib.request.urlretrieve(onnx_url, voices / f"{voice_id}.onnx")
        urllib.request.urlretrieve(config_url, voices / f"{voice_id}.onnx.json")


image = (
    modal.Image.debian_slim()
    .pip_install_from_requirements("requirements.txt")
    .env({
        "PIPER_BINARY_PATH": "/root/piper/piper",
        "PIPER_VOICES_DIR": "/root/piper/voices",
        "PIPER_VOICE_IDS": ",".join(VOICE_IDS),
    })
    .run_function(install_piper_and_voices)
    .add_local_file("main.py", remote_path="/root/main.py")
)

app = modal.App("piper-service", image=image)


@app.function(
    secrets=[modal.Secret.from_name("piper-service-secrets")],
    timeout=120,
    min_containers=0,
)
@modal.asgi_app()
def fastapi_app():
    import sys

    sys.path.insert(0, "/root")
    from main import app as web_app

    return web_app
