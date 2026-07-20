from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .contracts import GenerationRequest


class RuntimeConfigurationError(RuntimeError):
    pass


class GenerationFailed(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimeConfig:
    backend: str
    input_root: Path
    output_root: Path
    ltx_repo: Path | None
    python: str
    pipeline_config: str

    @classmethod
    def from_environment(cls) -> "RuntimeConfig":
        experiment_root = Path(__file__).resolve().parents[1]
        repo_value = os.getenv("LTX_REPO_PATH", "").strip()
        return cls(
            backend=os.getenv("LTX_KEYFRAMES_BACKEND", "dry-run").strip(),
            input_root=Path(
                os.getenv("LTX_KEYFRAMES_INPUT_ROOT", experiment_root / "fixtures")
            ).resolve(),
            output_root=Path(
                os.getenv("LTX_KEYFRAMES_OUTPUT_ROOT", experiment_root / "artifacts")
            ).resolve(),
            ltx_repo=Path(repo_value).resolve() if repo_value else None,
            python=os.getenv("LTX_PYTHON", sys.executable),
            pipeline_config=os.getenv(
                "LTX_PIPELINE_CONFIG", "configs/ltxv-13b-0.9.8-distilled.yaml"
            ),
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _inside(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_inputs(request: GenerationRequest, input_root: Path) -> list[Path]:
    resolved: list[Path] = []
    for keyframe in request.keyframes:
        candidate = Path(keyframe.image)
        if not candidate.is_absolute():
            candidate = input_root / candidate
        candidate = candidate.resolve()
        if not _inside(candidate, input_root):
            raise GenerationFailed(f"keyframe path escapes input root: {keyframe.image}")
        if not candidate.is_file():
            raise GenerationFailed(f"keyframe image does not exist: {keyframe.image}")
        resolved.append(candidate)
    return resolved


def build_official_cli_command(
    request: GenerationRequest,
    inputs: list[Path],
    output_path: Path,
    config: RuntimeConfig,
) -> list[str]:
    return [
        config.python,
        "inference.py",
        "--prompt",
        request.prompt,
        "--conditioning_media_paths",
        *[str(path) for path in inputs],
        "--conditioning_start_frames",
        *[str(item.frame_index) for item in request.keyframes],
        "--height",
        str(request.settings.height),
        "--width",
        str(request.settings.width),
        "--num_frames",
        str(request.settings.num_frames),
        "--seed",
        str(request.settings.seed),
        "--pipeline_config",
        config.pipeline_config,
        "--output_path",
        str(output_path),
    ]


class VramSampler:
    def __init__(self) -> None:
        self.peak_mib: int | None = None
        self._stopped = threading.Event()
        self._thread: threading.Thread | None = None

    @staticmethod
    def _sample() -> int | None:
        if shutil.which("nvidia-smi") is None:
            return None
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            return None
        values = [int(line.strip()) for line in result.stdout.splitlines() if line.strip()]
        return max(values) if values else None

    def start(self) -> None:
        def sample_until_stopped() -> None:
            while not self._stopped.is_set():
                current = self._sample()
                if current is not None:
                    self.peak_mib = max(self.peak_mib or 0, current)
                self._stopped.wait(0.5)

        self._thread = threading.Thread(target=sample_until_stopped, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        if self._thread:
            self._thread.join(timeout=2)


def _git_revision(repo: Path | None) -> str | None:
    if repo is None:
        return None
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def run_generation(request: GenerationRequest, config: RuntimeConfig) -> dict[str, Any]:
    if config.backend not in {"dry-run", "official-cli"}:
        raise RuntimeConfigurationError(
            "LTX_KEYFRAMES_BACKEND must be dry-run or official-cli"
        )
    inputs = resolve_inputs(request, config.input_root)
    request_id = str(uuid.uuid4())
    run_dir = config.output_root / request_id
    run_dir.mkdir(parents=True, exist_ok=False)
    output_path = run_dir / "output.mp4"
    manifest_path = run_dir / "manifest.json"
    command = build_official_cli_command(request, inputs, output_path, config)
    manifest: dict[str, Any] = {
        "schemaVersion": 1,
        "experiment": "ltx-multi-keyframe",
        "requestId": request_id,
        "backend": config.backend,
        "request": request.as_dict(),
        "inputs": [
            {
                "frameIndex": item.frame_index,
                "path": str(path),
                "sha256": _sha256(path),
            }
            for item, path in zip(request.keyframes, inputs, strict=True)
        ],
        "runtime": {
            "ltxRevision": _git_revision(config.ltx_repo),
            "pipelineConfig": config.pipeline_config,
            "command": command,
        },
    }

    if config.backend == "dry-run":
        manifest["result"] = {
            "status": "planned",
            "runtimeSec": 0.0,
            "peakVramMiB": None,
            "videoPath": None,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        return manifest

    if config.ltx_repo is None or not (config.ltx_repo / "inference.py").is_file():
        raise RuntimeConfigurationError(
            "LTX_REPO_PATH must point to an official LTX-Video checkout"
        )
    sampler = VramSampler()
    started = time.monotonic()
    sampler.start()
    try:
        result = subprocess.run(
            command,
            cwd=config.ltx_repo,
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        sampler.stop()
    runtime_sec = round(time.monotonic() - started, 3)
    (run_dir / "stdout.log").write_text(result.stdout)
    (run_dir / "stderr.log").write_text(result.stderr)
    manifest["result"] = {
        "status": "succeeded" if result.returncode == 0 else "failed",
        "exitCode": result.returncode,
        "runtimeSec": runtime_sec,
        "peakVramMiB": sampler.peak_mib,
        "videoPath": str(output_path) if output_path.is_file() else None,
        "videoSha256": _sha256(output_path) if output_path.is_file() else None,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    if result.returncode or not output_path.is_file():
        raise GenerationFailed(
            f"official LTX inference failed; inspect {run_dir / 'stderr.log'}"
        )
    return manifest
