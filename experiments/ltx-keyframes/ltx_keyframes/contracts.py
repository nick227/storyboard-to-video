from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


class ContractError(ValueError):
    pass


@dataclass(frozen=True)
class Keyframe:
    frame_index: int
    image: str


@dataclass(frozen=True)
class Settings:
    width: int = 768
    height: int = 512
    num_frames: int = 121
    seed: int = 42


@dataclass(frozen=True)
class GenerationRequest:
    keyframes: tuple[Keyframe, ...]
    prompt: str
    settings: Settings

    def as_dict(self) -> dict[str, Any]:
        return {
            "keyframes": [
                {"frameIndex": item.frame_index, "image": item.image}
                for item in self.keyframes
            ],
            "prompt": self.prompt,
            "settings": {
                "width": self.settings.width,
                "height": self.settings.height,
                "numFrames": self.settings.num_frames,
                "seed": self.settings.seed,
            },
        }


def _integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(f"{field} must be an integer")
    return value


def parse_request(payload: Any) -> GenerationRequest:
    if not isinstance(payload, dict):
        raise ContractError("request body must be an object")

    unknown = set(payload) - {"keyframes", "prompt", "settings"}
    if unknown:
        raise ContractError(f"unknown request fields: {', '.join(sorted(unknown))}")

    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ContractError("prompt must be a non-empty string")
    if len(prompt) > 4_000:
        raise ContractError("prompt must not exceed 4000 characters")

    raw_settings = payload.get("settings", {})
    if not isinstance(raw_settings, dict):
        raise ContractError("settings must be an object")
    unknown_settings = set(raw_settings) - {"width", "height", "numFrames", "seed"}
    if unknown_settings:
        raise ContractError(
            f"unknown settings: {', '.join(sorted(unknown_settings))}"
        )
    settings = Settings(
        width=_integer(raw_settings.get("width", 768), "settings.width"),
        height=_integer(raw_settings.get("height", 512), "settings.height"),
        num_frames=_integer(
            raw_settings.get("numFrames", 121), "settings.numFrames"
        ),
        seed=_integer(raw_settings.get("seed", 42), "settings.seed"),
    )
    if not 64 <= settings.width <= 1280 or settings.width % 32:
        raise ContractError("settings.width must be 64..1280 and divisible by 32")
    if not 64 <= settings.height <= 1280 or settings.height % 32:
        raise ContractError("settings.height must be 64..1280 and divisible by 32")
    if not 9 <= settings.num_frames <= 257 or (settings.num_frames - 1) % 8:
        raise ContractError(
            "settings.numFrames must be 9..257 and satisfy (numFrames - 1) % 8 == 0"
        )

    raw_keyframes = payload.get("keyframes")
    if not isinstance(raw_keyframes, list) or not 1 <= len(raw_keyframes) <= 8:
        raise ContractError("keyframes must contain between 1 and 8 items")

    keyframes: list[Keyframe] = []
    for position, raw in enumerate(raw_keyframes):
        if not isinstance(raw, dict):
            raise ContractError(f"keyframes[{position}] must be an object")
        unknown_keyframe = set(raw) - {"frameIndex", "image"}
        if unknown_keyframe:
            raise ContractError(
                f"unknown keyframes[{position}] fields: "
                f"{', '.join(sorted(unknown_keyframe))}"
            )
        frame_index = _integer(
            raw.get("frameIndex"), f"keyframes[{position}].frameIndex"
        )
        image = raw.get("image")
        if not isinstance(image, str) or not image.strip():
            raise ContractError(f"keyframes[{position}].image must be a path")
        if frame_index < 0 or frame_index >= settings.num_frames:
            raise ContractError(
                f"keyframes[{position}].frameIndex must be within the output"
            )
        if frame_index % 8:
            raise ContractError(
                f"keyframes[{position}].frameIndex must be divisible by 8"
            )
        keyframes.append(Keyframe(frame_index=frame_index, image=image.strip()))

    indices = [item.frame_index for item in keyframes]
    if indices != sorted(indices) or len(indices) != len(set(indices)):
        raise ContractError("keyframes must have unique ascending frameIndex values")
    if indices[0] != 0:
        raise ContractError("this experiment requires its first keyframe at frameIndex 0")

    return GenerationRequest(
        keyframes=tuple(keyframes), prompt=prompt.strip(), settings=settings
    )
