"""Frame/canvas helpers for MiniMax H3 (17k+5 @ 24fps, 32px grid)."""

from __future__ import annotations

import math

CANVAS_MULTIPLE = 32
BASE_SHORT_EDGE = 768
MAX_PIXELS = 768 * 1344


def align_frame_count(n: int) -> int:
    n = max(5, int(n))
    while n % 17 != 5:
        n += 1
    return n


def snap_dimensions(width: int, height: int) -> tuple[int, int]:
    """Round to H3 canvas grid and clamp to the 768-short-edge / max-pixel envelope."""
    width = max(CANVAS_MULTIPLE, int(width))
    height = max(CANVAS_MULTIPLE, int(height))
    ratio = width / height
    if ratio >= 1.0:
        nom_w, nom_h = BASE_SHORT_EDGE * ratio, float(BASE_SHORT_EDGE)
    else:
        nom_w, nom_h = float(BASE_SHORT_EDGE), BASE_SHORT_EDGE / ratio
    if nom_w * nom_h > MAX_PIXELS:
        scale = math.sqrt(MAX_PIXELS / (nom_w * nom_h))
        nom_w, nom_h = nom_w * scale, nom_h * scale
    # Prefer caller's requested size when already under the cap; only snap to 32.
    req_w = max(CANVAS_MULTIPLE, round(width / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    req_h = max(CANVAS_MULTIPLE, round(height / CANVAS_MULTIPLE) * CANVAS_MULTIPLE)
    if req_w * req_h <= MAX_PIXELS and max(req_w, req_h) <= max(int(nom_w), int(nom_h)) + CANVAS_MULTIPLE:
        return req_w, req_h
    return (
        max(CANVAS_MULTIPLE, round(nom_w / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
        max(CANVAS_MULTIPLE, round(nom_h / CANVAS_MULTIPLE) * CANVAS_MULTIPLE),
    )
