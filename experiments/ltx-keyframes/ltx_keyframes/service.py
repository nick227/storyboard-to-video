from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException

from .contracts import ContractError, parse_request
from .runner import (
    GenerationFailed,
    RuntimeConfig,
    RuntimeConfigurationError,
    run_generation,
)

app = FastAPI(title="Isolated LTX Keyframes Experiment", version="0.1.0")
generation_lock = asyncio.Lock()


def authorize(authorization: str | None = Header(default=None)) -> None:
    token = os.getenv("LTX_KEYFRAMES_TOKEN", "")
    if token and authorization != f"Bearer {token}":
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health() -> dict[str, Any]:
    config = RuntimeConfig.from_environment()
    return {
        "ok": True,
        "backend": config.backend,
        "experimental": True,
        "productionCapabilityPublished": False,
    }


@app.post("/v1/generations", dependencies=[Depends(authorize)])
async def generate(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        request = parse_request(payload)
    except ContractError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if generation_lock.locked():
        raise HTTPException(status_code=409, detail="Experiment GPU is busy")
    try:
        async with generation_lock:
            return await asyncio.to_thread(
                run_generation, request, RuntimeConfig.from_environment()
            )
    except RuntimeConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except GenerationFailed as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8013)
