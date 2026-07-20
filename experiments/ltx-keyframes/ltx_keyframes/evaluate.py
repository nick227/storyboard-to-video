from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from .matrix import CASES


RATING_FIELDS = (
    "startFrameFidelity",
    "endFrameFidelity",
    "identityConsistency",
    "middleMotionQuality",
    "artifactSeverity",
)


def mean(rows: list[dict[str, Any]], field: str) -> float:
    return round(statistics.fmean(float(row[field]) for row in rows), 3)


def evaluate(ratings: list[dict[str, Any]], gate: dict[str, Any]) -> dict[str, Any]:
    if not ratings:
        raise ValueError("ratings must not be empty")
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in ratings:
        if row.get("case") not in CASES:
            raise ValueError(f"unknown case: {row.get('case')}")
        for field in RATING_FIELDS:
            score = row.get(field)
            if not isinstance(score, (int, float)) or isinstance(score, bool) or not 1 <= score <= 5:
                raise ValueError(f"{field} must be scored from 1 to 5")
        grouped[row["case"]].append(row)
    for required in ("start-only", "start-end"):
        if not grouped[required]:
            raise ValueError(f"missing required case: {required}")

    control = grouped["start-only"]
    candidate = grouped["start-end"]
    control_by_category = {row["category"]: row for row in control}
    candidate_by_category = {row["category"]: row for row in candidate}
    if set(control_by_category) != set(candidate_by_category):
        raise ValueError("start-only and start-end must cover identical categories")

    endpoint_pass_rate = sum(
        row["startFrameFidelity"] >= 4 and row["endFrameFidelity"] >= 4
        for row in candidate
    ) / len(candidate)
    mean_end_improvement = mean(candidate, "endFrameFidelity") - mean(
        control, "endFrameFidelity"
    )
    category_improvements = {
        category: round(
            candidate_by_category[category]["endFrameFidelity"]
            - control_by_category[category]["endFrameFidelity"],
            3,
        )
        for category in control_by_category
    }
    categories_improved = sum(
        improvement >= gate["minimumCategoryEndFrameImprovement"]
        for improvement in category_improvements.values()
    )
    identity_regression = mean(control, "identityConsistency") - mean(
        candidate, "identityConsistency"
    )
    motion_regression = mean(control, "middleMotionQuality") - mean(
        candidate, "middleMotionQuality"
    )
    mean_artifacts = mean(candidate, "artifactSeverity")

    checks = {
        "endpointReliability": endpoint_pass_rate >= gate["minimumEndpointPassRate"],
        "endFrameImprovement": mean_end_improvement
        >= gate["minimumMeanEndFrameImprovement"],
        "categoryBreadth": categories_improved >= gate["minimumCategoriesImproved"],
        "identityNoRegression": identity_regression <= gate["maximumIdentityRegression"],
        "motionNoRegression": motion_regression <= gate["maximumMotionRegression"],
        "artifactCeiling": mean_artifacts <= gate["maximumMeanArtifactSeverity"],
    }
    return {
        "decision": "PRODUCTIZE" if all(checks.values()) else "DO_NOT_PRODUCTIZE",
        "checks": checks,
        "metrics": {
            "endpointPassRate": round(endpoint_pass_rate, 3),
            "meanEndFrameImprovement": round(mean_end_improvement, 3),
            "categoryEndFrameImprovements": category_improvements,
            "categoriesImproved": categories_improved,
            "identityRegression": round(identity_regression, 3),
            "motionRegression": round(motion_regression, 3),
            "meanArtifactSeverity": mean_artifacts,
            "meanRuntimeSecByCase": {
                case: mean(rows, "runtimeSec") for case, rows in grouped.items()
            },
            "peakVramMiBByCase": {
                case: max(float(row["peakVramMiB"]) for row in rows)
                for case, rows in grouped.items()
            },
        },
        "gate": gate,
        "interpretation": (
            "Publish supportsEndFrame only after PRODUCTIZE is reproduced across "
            "the fixed fixture set. The stronger-motion case is diagnostic and is "
            "not allowed to rescue a failed start+end gate."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Apply the binary LTX productization gate")
    parser.add_argument("ratings", type=Path)
    parser.add_argument("--gate", type=Path, default=Path("gate.json"))
    parser.add_argument("--output", type=Path, default=Path("evaluation-report.json"))
    args = parser.parse_args()
    ratings = json.loads(args.ratings.read_text())["ratings"]
    gate = json.loads(args.gate.read_text())
    report = evaluate(ratings, gate)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(report["decision"])
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
