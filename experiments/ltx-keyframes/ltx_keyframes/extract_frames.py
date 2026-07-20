from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract start, middle, and end review frames")
    parser.add_argument("video", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    filters = {
        "start.png": "select=eq(n\\,0)",
        "middle.png": "select=eq(n\\,60)",
        "end.png": "select=eq(n\\,120)",
    }
    for filename, expression in filters.items():
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(args.video),
                "-vf",
                expression,
                "-frames:v",
                "1",
                str(args.output_dir / filename),
            ],
            check=True,
        )


if __name__ == "__main__":
    main()
