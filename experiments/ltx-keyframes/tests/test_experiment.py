from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ltx_keyframes.contracts import ContractError, parse_request
from ltx_keyframes.evaluate import evaluate
from ltx_keyframes.matrix import build_payloads
from ltx_keyframes.runner import (
    RuntimeConfig,
    build_official_cli_command,
    resolve_inputs,
    run_generation,
)


VALID_REQUEST = {
    "keyframes": [
        {"frameIndex": 0, "image": "start.png"},
        {"frameIndex": 120, "image": "end.png"},
    ],
    "prompt": "A fixed experiment prompt.",
    "settings": {"width": 768, "height": 512, "numFrames": 121, "seed": 42},
}


class ContractTests(unittest.TestCase):
    def test_accepts_start_and_end_at_ltx_aligned_indices(self):
        request = parse_request(VALID_REQUEST)
        self.assertEqual([frame.frame_index for frame in request.keyframes], [0, 120])

    def test_rejects_misaligned_or_duplicate_indices(self):
        for indices in ([0, 119], [0, 0], [8, 120]):
            payload = json.loads(json.dumps(VALID_REQUEST))
            payload["keyframes"] = [
                {"frameIndex": index, "image": f"{position}.png"}
                for position, index in enumerate(indices)
            ]
            with self.subTest(indices=indices), self.assertRaises(ContractError):
                parse_request(payload)

    def test_rejects_unknown_settings(self):
        payload = json.loads(json.dumps(VALID_REQUEST))
        payload["settings"]["providerSpecificMagic"] = True
        with self.assertRaises(ContractError):
            parse_request(payload)


class RunnerTests(unittest.TestCase):
    def test_resolves_only_files_inside_fixture_root_and_builds_official_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "start.png").write_bytes(b"start")
            (root / "end.png").write_bytes(b"end")
            request = parse_request(VALID_REQUEST)
            paths = resolve_inputs(request, root)
            config = RuntimeConfig(
                backend="official-cli",
                input_root=root,
                output_root=root / "output",
                ltx_repo=root / "LTX-Video",
                python="/venv/bin/python",
                pipeline_config="configs/test.yaml",
            )
            command = build_official_cli_command(request, paths, root / "out.mp4", config)
            media_position = command.index("--conditioning_media_paths")
            frames_position = command.index("--conditioning_start_frames")
            self.assertEqual(command[media_position + 1 : frames_position], [str(path) for path in paths])
            self.assertEqual(command[frames_position + 1 : frames_position + 3], ["0", "120"])
            self.assertIn("--output_path", command)

    def test_rejects_path_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "fixtures"
            root.mkdir()
            outside = Path(temp) / "outside.png"
            outside.write_bytes(b"outside")
            payload = json.loads(json.dumps(VALID_REQUEST))
            payload["keyframes"] = [{"frameIndex": 0, "image": "../outside.png"}]
            with self.assertRaisesRegex(Exception, "escapes input root"):
                resolve_inputs(parse_request(payload), root)

    def test_dry_run_needs_fixtures_but_not_model_checkout(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "start.png").write_bytes(b"start")
            (root / "end.png").write_bytes(b"end")
            config = RuntimeConfig(
                backend="dry-run",
                input_root=root,
                output_root=root / "artifacts",
                ltx_repo=None,
                python="python",
                pipeline_config="configs/test.yaml",
            )
            result = run_generation(parse_request(VALID_REQUEST), config)
            self.assertEqual(result["result"]["status"], "planned")
            self.assertIsNone(result["runtime"]["ltxRevision"])


class MatrixTests(unittest.TestCase):
    def test_fixed_matrix_is_three_cases_by_three_fixture_types(self):
        fixture_manifest = json.loads(
            (Path(__file__).parents[1] / "fixtures.example.json").read_text()
        )
        runs = build_payloads(fixture_manifest)
        self.assertEqual(len(runs), 9)
        self.assertEqual({run["case"] for run in runs}, {"start-only", "start-end", "start-end-motion"})
        self.assertEqual(len({run["category"] for run in runs}), 3)
        self.assertEqual(
            len(next(run for run in runs if run["case"] == "start-only")["request"]["keyframes"]),
            1,
        )
        self.assertEqual(
            len(next(run for run in runs if run["case"] == "start-end")["request"]["keyframes"]),
            2,
        )


def rating(category: str, case: str, *, end: int, identity: int = 4, motion: int = 4, artifacts: int = 1):
    return {
        "fixtureId": category,
        "category": category,
        "case": case,
        "startFrameFidelity": 4,
        "endFrameFidelity": end,
        "identityConsistency": identity,
        "middleMotionQuality": motion,
        "artifactSeverity": artifacts,
        "runtimeSec": 10,
        "peakVramMiB": 1000,
    }


GATE = {
    "minimumEndpointPassRate": 1.0,
    "minimumMeanEndFrameImprovement": 0.75,
    "minimumCategoriesImproved": 3,
    "minimumCategoryEndFrameImprovement": 0.75,
    "maximumIdentityRegression": 0.5,
    "maximumMotionRegression": 0.5,
    "maximumMeanArtifactSeverity": 2.0,
}


class EvaluationTests(unittest.TestCase):
    def test_productizes_only_when_boundary_control_is_reliable_without_regressions(self):
        categories = ("character", "product", "location")
        ratings = [rating(category, "start-only", end=2) for category in categories]
        ratings += [rating(category, "start-end", end=4) for category in categories]
        report = evaluate(ratings, GATE)
        self.assertEqual(report["decision"], "PRODUCTIZE")
        self.assertTrue(all(report["checks"].values()))

    def test_rejects_endpoint_success_with_bad_middle_motion(self):
        categories = ("character", "product", "location")
        ratings = [rating(category, "start-only", end=2, motion=4) for category in categories]
        ratings += [rating(category, "start-end", end=4, motion=2) for category in categories]
        report = evaluate(ratings, GATE)
        self.assertEqual(report["decision"], "DO_NOT_PRODUCTIZE")
        self.assertFalse(report["checks"]["motionNoRegression"])

    def test_rejects_when_only_two_of_three_fixture_types_improve(self):
        categories = ("character", "product", "location")
        ratings = [rating(category, "start-only", end=2) for category in categories]
        ratings += [
            rating("character", "start-end", end=4),
            rating("product", "start-end", end=4),
            rating("location", "start-end", end=2),
        ]
        report = evaluate(ratings, GATE)
        self.assertEqual(report["decision"], "DO_NOT_PRODUCTIZE")
        self.assertFalse(report["checks"]["categoryBreadth"])


if __name__ == "__main__":
    unittest.main()
