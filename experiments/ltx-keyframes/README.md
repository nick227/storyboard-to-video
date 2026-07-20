# Isolated LTX multi-keyframe experiment

This runtime answers one question: **does start+end conditioning materially improve controllability without making identity, middle motion, or artifacts unacceptable?** It is not a product video provider.

It deliberately has no imports, routes, configuration, data writes, or capability changes in `apps/web`. The existing production LTX runtime remains start-frame-only. In particular, this experiment does **not** publish `supportsEndFrame: true`.

## Experiment contract

The only generation endpoint is `POST /v1/generations`:

```json
{
  "keyframes": [
    { "frameIndex": 0, "image": "character-movement/start.png" },
    { "frameIndex": 120, "image": "character-movement/end.png" }
  ],
  "prompt": "The same character crosses the room and sits.",
  "settings": {
    "width": 768,
    "height": 512,
    "numFrames": 121,
    "seed": 42
  }
}
```

Paths resolve only inside `LTX_KEYFRAMES_INPUT_ROOT`. Frame indices must be unique, ascending, divisible by 8, and inside a frame count satisfying `8n + 1`. The first keyframe must be frame 0 for this experiment. Those restrictions keep every run comparable and match the official LTX conditioning interface.

Each run gets an immutable local manifest containing the request, exact input paths and SHA-256 hashes, official LTX checkout revision, pipeline config, CLI invocation, runtime, peak observed GPU memory, output hash, and logs. These artifacts are intentionally ignored by Git.

## Stand up the separate runtime

Clone and install the official LTX repository in its own environment, following its inference documentation. Do not reuse `/home/administrator/web/ltx-env/server.py`; that is the production-style, single-image Diffusers path.

```bash
cd experiments/ltx-keyframes
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Load the values in `.env`, initially leaving `LTX_KEYFRAMES_BACKEND=dry-run`. Populate the three fixture directories beneath the configured input root, or point the root at an external fixture directory. Copy `fixtures.example.json` to the ignored `fixtures.local.json` and update only image paths if needed.

Start the experiment API from this directory:

```bash
PYTHONPATH=. .venv/bin/uvicorn ltx_keyframes.service:app --host 127.0.0.1 --port 8013
```

Dry-run mode validates and hashes real fixture files and emits the exact official CLI plan without invoking a model. Once that passes, configure the official checkout and switch only this service to:

```text
LTX_KEYFRAMES_BACKEND=official-cli
```

The runner invokes the official `inference.py` with `--conditioning_media_paths` and matching `--conditioning_start_frames`. Keep the same checkout revision, pipeline config, dimensions, frame count, and seed for the full matrix.

## Fixed nine-run matrix

The fixture manifest defines exactly three content types:

- character movement
- product/object movement
- camera/location transition

Each runs exactly three cases:

- start frame only
- start + end frame, same base prompt
- start + end frame, stronger explicit action/motion prompt

Create a plan without calling the service:

```bash
PYTHONPATH=. python -m ltx_keyframes.matrix fixtures.local.json --plan --output artifacts/matrix-plan.json
```

Run the matrix against the isolated service:

```bash
PYTHONPATH=. python -m ltx_keyframes.matrix fixtures.local.json --output artifacts/matrix-results.json
```

Use distinct but compositionally comparable start/end images for each fixture. Do not use a scene from the evaluation set to tune prompts after seeing output; if a prompt changes, rerun all three cases.

## Review and binary decision

Extract frames 0, 60, and 120 for review with:

```bash
PYTHONPATH=. python -m ltx_keyframes.extract_frames artifacts/RUN_ID/output.mp4 artifacts/RUN_ID/review
```

Have reviewers score outputs blind to case on the five fields in `ratings.example.json`:

- start-frame fidelity, 1–5
- end-frame fidelity against the intended end image, 1–5 (also score start-only)
- identity consistency through sampled frames, 1–5
- motion quality through the middle, 1–5
- artifact severity, 1 clean through 5 unusable

Runtime and peak VRAM come from run manifests rather than reviewer judgment. The endpoint images alone are insufficient: inspect the full video before scoring identity, motion, and artifacts.

Copy the rating structure to ignored `ratings.local.json`, include all nine runs, then apply the preregistered gate:

```bash
PYTHONPATH=. python -m ltx_keyframes.evaluate ratings.local.json --gate gate.json --output artifacts/evaluation-report.json
```

The outcome is deliberately binary:

- `PRODUCTIZE`: start+end reliably improves end control across all three fixture classes, both endpoints are respected in every candidate run, and identity, middle motion, and artifacts stay within the declared limits. Reproduce once before changing the neutral provider capability.
- `DO_NOT_PRODUCTIZE`: keep `endFrame` dormant and proceed to Veo. The stronger-motion diagnostic can explain failure but cannot rescue a failed base start+end comparison.

## Tests

The contract, path boundary, official CLI mapping, fixed matrix, and decision gate use only the Python standard library:

```bash
PYTHONPATH=. python -m unittest discover -s tests -v
```
