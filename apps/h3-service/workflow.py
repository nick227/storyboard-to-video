"""Build ComfyUI API-format FL2VA prompt graphs for MiniMax H3."""

from __future__ import annotations

from typing import Any, Optional


def build_fl2va_prompt(
    *,
    prompt: str,
    width: int,
    height: int,
    length: int,
    seed: int,
    steps: int = 20,
    first_frame: Optional[str] = None,
    last_frame: Optional[str] = None,
    filename_prefix: str = "h3",
    unet_name: str = "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    clip_name: str = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    video_vae_name: str = "minimax_h3_video_vae_fp16.safetensors",
    audio_vae_name: str = "minimax_h3_audio_vae_fp32.safetensors",
    sampler_name: str = "res_multistep",
    scheduler: str = "simple",
) -> dict[str, Any]:
    """Return an API-format workflow matching the official MiniMax H3 I2V subgraph."""
    graph: dict[str, Any] = {
        "6": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": unet_name, "weight_dtype": "default"},
        },
        "13": {
            "class_type": "CLIPLoader",
            "inputs": {"clip_name": clip_name, "type": "minimax", "device": "default"},
        },
        "11": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": video_vae_name},
        },
        "24": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": audio_vae_name},
        },
        "104": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {
                "clip": ["13", 0],
                "vae": ["11", 0],
                "prompt": prompt,
                "width": width,
                "height": height,
                "length": length,
            },
        },
        "15": {
            "class_type": "RandomNoise",
            "inputs": {"noise_seed": seed},
        },
        "17": {
            "class_type": "KSamplerSelect",
            "inputs": {"sampler_name": sampler_name},
        },
        "9": {
            "class_type": "BasicScheduler",
            "inputs": {
                "model": ["6", 0],
                "scheduler": scheduler,
                "steps": steps,
                "denoise": 1.0,
            },
        },
        "16": {
            "class_type": "BasicGuider",
            "inputs": {
                "model": ["6", 0],
                "conditioning": ["104", 0],
            },
        },
        "14": {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {
                "noise": ["15", 0],
                "guider": ["16", 0],
                "sampler": ["17", 0],
                "sigmas": ["9", 0],
                "latent_image": ["104", 1],
            },
        },
        "10": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["14", 0],
                "vae": ["11", 0],
            },
        },
        "23": {
            "class_type": "VAEDecodeAudio",
            "inputs": {
                "samples": ["14", 0],
                "vae": ["24", 0],
            },
        },
        "91": {
            "class_type": "CreateVideo",
            "inputs": {
                "images": ["10", 0],
                "fps": 24.0,
                "audio": ["23", 0],
                "bit_depth": 8,
            },
        },
        "92": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["91", 0],
                "filename_prefix": filename_prefix,
                "format": "auto",
                "codec": "auto",
            },
        },
    }

    if first_frame:
        graph["114"] = {
            "class_type": "LoadImage",
            "inputs": {"image": first_frame},
        }
        graph["104"]["inputs"]["first_frame"] = ["114", 0]

    if last_frame:
        graph["115"] = {
            "class_type": "LoadImage",
            "inputs": {"image": last_frame},
        }
        graph["104"]["inputs"]["last_frame"] = ["115", 0]

    return graph
