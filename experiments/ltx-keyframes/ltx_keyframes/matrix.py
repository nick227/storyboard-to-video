from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


CASES = ("start-only", "start-end", "start-end-motion")


def build_payloads(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    settings = manifest["settings"]
    end_index = settings["numFrames"] - 1
    payloads: list[dict[str, Any]] = []
    for fixture in manifest["fixtures"]:
        start = {"frameIndex": 0, "image": fixture["startImage"]}
        end = {"frameIndex": end_index, "image": fixture["endImage"]}
        for case in CASES:
            payloads.append(
                {
                    "fixtureId": fixture["id"],
                    "category": fixture["category"],
                    "case": case,
                    "request": {
                        "keyframes": [start] if case == "start-only" else [start, end],
                        "prompt": (
                            fixture["strongMotionPrompt"]
                            if case == "start-end-motion"
                            else fixture["prompt"]
                        ),
                        "settings": settings,
                    },
                }
            )
    return payloads


def post(url: str, token: str, body: dict[str, Any]) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise RuntimeError(f"experiment service returned {exc.code}: {detail}") from exc


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the fixed LTX keyframe matrix")
    parser.add_argument("fixture_manifest", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8013/v1/generations")
    parser.add_argument("--output", type=Path, default=Path("matrix-results.json"))
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.fixture_manifest.read_text())
    runs = build_payloads(manifest)
    if not args.plan:
        token = os.getenv("LTX_KEYFRAMES_TOKEN", "")
        for run in runs:
            run["result"] = post(args.url, token, run["request"])
    args.output.write_text(json.dumps({"schemaVersion": 1, "runs": runs}, indent=2) + "\n")
    print(f"Wrote {len(runs)} runs to {args.output}")


if __name__ == "__main__":
    main()
