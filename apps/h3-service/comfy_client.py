"""HTTP client for the ComfyUI prompt API."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from uuid import uuid4


class ComfyClientError(RuntimeError):
    pass


class ComfyClient:
    def __init__(self, base_url: str, client_id: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id or uuid4().hex

    def _request(self, method: str, path: str, body: dict | None = None, timeout: float = 30) -> Any:
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                if not raw:
                    return None
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "ignore")
            raise ComfyClientError(f"HTTP {exc.code}: {detail or exc.reason}") from exc
        except urllib.error.URLError as exc:
            raise ComfyClientError(str(exc.reason or exc)) from exc

    def system_stats(self) -> dict:
        return self._request("GET", "/system_stats", timeout=5)

    def queue_prompt(self, prompt: dict) -> str:
        result = self._request(
            "POST",
            "/prompt",
            {"prompt": prompt, "client_id": self.client_id},
            timeout=60,
        )
        prompt_id = (result or {}).get("prompt_id")
        if not prompt_id:
            raise ComfyClientError(f"ComfyUI did not return prompt_id: {result}")
        return prompt_id

    def history(self, prompt_id: str) -> dict:
        return self._request("GET", f"/history/{prompt_id}", timeout=30) or {}
