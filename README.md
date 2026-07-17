# Storyboard Image POC

Gemini-first POC for turning story text into a storyboard with editable prompts, serial image generation, scene versions, and per-style reference images.

## What changed in this version
- Gemini is now the default text and image provider (`gemini-3.5-flash` and `gemini-3.1-flash-image` by default)
- Each style now has its own character reference images and world reference images
- Reference images can be uploaded, previewed, and deleted in the UI
- Gemini uses scene-linked named references when generating images
- Starter reference images are included for all 5 styles

## Features
- Paste script or story text into a textarea
- Generate N storyboard scene prompts with Gemini or OpenAI
- Choose one of 5 styles stored as markdown prompt files
- Review and edit prompts in a storyboard grid
- Upload style-specific character references and world references
- Generate images serially with Gemini, OpenAI, or Dezgo
- Stop and resume serial generation
- Regenerate individual prompts and individual images
- Disable redundant batch prompt generation until the story or common prompt changes
- Preserve old images as scene versions and switch between them
- Preview each scene through one synchronized video/audio transport with seeking, silence padding, and video looping when audio is longer
- Reorder scenes
- Download selected scene images and a prompt-rich `storyboard.json` manifest as a ZIP
- Create and switch between autosaved storyboards in browser localStorage
- Validate and limit reference uploads to 8 images per category and 8 MB per image
- Warn when local fallback prompts are used because a text provider is unavailable
- Persist storyboards and generated media under a server-side project directory
- Serialize generation through a cancellable in-process queue
- Return one structured error shape from API endpoints

## Included styles
- Basic Cartoon
- Cinematic Reality
- Dark Gothic
- Indie Youtuber
- Vox Style

## Repo layout

This is a monorepo with two independently run, tested, and deployed apps, plus a thin root orchestrator:
```
apps/web/            Node/Express storyboard app -> deploys to Railway
apps/voice-service/  Python/FastAPI + Spark-TTS voice cloning daemon (GPU) -> deploys to Modal
package.json          root-level scripts only, no dependencies of its own
```
The two apps talk to each other over plain HTTP, configured entirely through environment variables (`SPARK_TTS_URL` on the web side) plus a shared bearer token (`SPARK_SERVICE_TOKEN`) — see [Deployment](#deployment) below. Each has its own `.env`/`.env.example`; there is no shared root `.env`.

## Quick start
1. Copy `apps/web/.env.example` to `apps/web/.env` and fill in at least `GEMINI_API_KEY`
2. Install dependencies:
   ```bash
   npm --prefix apps/web install
   ```
3. Start PostgreSQL and apply committed migrations:
   ```bash
   docker compose up -d postgres
   npm --prefix apps/web run prisma:migrate:deploy
   ```
4. (Optional) Install the local Piper voice engine for natural-sounding offline TTS:
   ```bash
   npm run setup:piper
   ```
5. Start the app:
   ```bash
   npm run dev:web
   ```
6. Open `http://localhost:3000`

Root-level scripts (`npm run <script>` from the repo root) drive both apps: `dev:web`, `dev:voice`, `check`, `test`, `setup:piper`, `setup:spark`.

## Local voices
- The audio provider dropdown includes two zero-API-key options: a rudimentary local voice (always available, no setup) and **Piper** (natural neural TTS, requires `npm run setup:piper` once — downloads a ~26 MB engine and a ~60 MB voice model into `apps/web/vendor/piper/`, not committed to git).
- ElevenLabs remains available as a cloud option when `ELEVENLABS_API_KEY` is set.
- Each detected speaker is auto-assigned a voice for the local providers; no manual mapping is required unless you're using ElevenLabs.

## Voice cloning (Spark-TTS, local GPU or Modal)
- The "Voice cloning (local, custom)" audio provider lets you record or upload a short sample directly in the app and get a custom voice for any character — Apache-2.0 licensed (commercial-safe), zero-shot cloning (no transcript required).
- Lives entirely in `apps/voice-service/`, a separate app from `apps/web` — see [Repo layout](#repo-layout). Requires an NVIDIA GPU (tested on an RTX 3060, 12 GB VRAM) and Python 3 to run for real; a CPU fallback exists but is realistically too slow for interactive use. One-time setup, run from the repo root:
  ```bash
  npm run setup:spark
  ```
  This creates `apps/voice-service/venv`, installs PyTorch + the Spark-TTS inference code, and downloads the `SparkAudio/Spark-TTS-0.5B` weights (~4 GB) into `apps/voice-service/pretrained_models/` — roughly 6-7 GB total, none of it committed to git.
- Copy `apps/voice-service/.env.example` to `apps/voice-service/.env` and set `SPARK_SERVICE_TOKEN` to match the same value in `apps/web/.env` (any random string works for local dev; if you leave it blank, the service stays open with a startup warning — fine locally, never for a real deploy).
- Start the voice-cloning daemon in its own terminal before selecting the provider in the UI:
  ```bash
  npm run dev:voice
  ```
  It loads the model once (a few seconds) and serves on `http://localhost:8001` (configurable via `SPARK_TTS_URL` on the `apps/web` side). The app shows a clear "unavailable" status if you pick this provider without it running, rather than failing silently.
- Cloned voices are stored under `apps/voice-service/voices/<voiceId>/` and are reusable across every speaker/scene/storyboard, the same way ElevenLabs voices are.

## Reference image behavior
- Style references live under `style-references/<style-id>/characters` and `style-references/<style-id>/world`
- The app automatically loads the active style's references
- Gemini image generation receives the active style's character and world references. Scene prompts stay focused on the visible action.
- OpenAI and Dezgo remain available as optional alternates

## Storage
- Storyboards are cached in localStorage for responsive editing and synchronized to `apps/web/data/projects/<project-id>/project.json`
- Project images, audio, video, and exports live under `apps/web/data/projects/<project-id>/assets/<type>`
- Project writes use monotonic revisions and stale `If-Match` updates return `409 REVISION_CONFLICT`
- Legacy `/generated`, `/audio`, and `/videos` version paths are copied into the owned project asset tree during normalization instead of being discarded.
- Generation requires a project and an `Idempotency-Key`; legacy public media mounts are disabled
- `POST /api/projects/:projectId/cleanup` removes assets no longer referenced by the project document
- `DELETE /api/projects/:projectId` cancels its active jobs and removes the entire project tree
- Deleted project IDs are tombstoned and cannot be recreated by late jobs

## Pipeline API

- Generation responses include `X-Generation-Job-Id`; jobs can be listed at `GET /api/jobs` and cancelled with `DELETE /api/jobs/:jobId`
- Job state is persisted under `apps/web/data/jobs`; queued/running work is recovered as `interrupted` after restart
- Text requests accept `fallbackPolicy: "fail" | "local"`. The UI defaults to `fail`, so local fallback is never silently selected.
- API failures use `{ "ok": false, "error": { "code", "message", "retryable", "requestId", "details"? } }`
- ZIP exports place selected assets in `images/`, `audio/`, and `videos/`, and include `storyboard.json`

## Composition root

- `apps/web/server.js` only loads configuration, creates dependencies and the Express app, starts the listener, and exposes compatibility test exports.
- `apps/web/src/app.js` owns middleware/route registration; route modules contain URL composition only.
- Controllers translate HTTP requests, services own generation and persistence workflows, providers own external API construction, and `apps/web/src/media` owns format/stub utilities.
- Services receive their storage/provider dependencies from `apps/web/src/dependencies.js` and have direct unit coverage in `apps/web/test/services.test.js`.

## Deployment

**Nothing is deployed yet** — this section documents the boundary that's ready, not something live.

- **`apps/web` → Railway.** `apps/web/Dockerfile` + `apps/web/railway.toml` are ready. Railway's Hobby tier has no GPU on any plan (confirmed directly against their docs), which is exactly why voice cloning lives in a separate app instead. One manual step this repo can't do for you: in the Railway dashboard, create a service pointed at this repo and set its **Root Directory** to `apps/web` — `railway.toml` lives inside that directory specifically because Railway resolves it (and its `watchPatterns`) relative to whatever Root Directory is configured.
- **`apps/voice-service` → Modal.** `apps/voice-service/modal_app.py` defines the deployment (GPU function serving the existing FastAPI app via `@modal.asgi_app()`, model weights baked into the image, cloned voices on a persistent Modal Volume) but is **not deployed**. Before running `modal deploy apps/voice-service/modal_app.py` for real, you'd need a Modal account plus a one-time `modal secret create voice-service-secrets SPARK_SERVICE_TOKEN=... SPARK_TEMPERATURE=0.8 ...` and `modal volume create voice-service-voices`.
- **CI**: `.github/workflows/ci.yml` runs Node checks/tests and mocked voice-service tests (no GPU, no real model — `SPARK_SKIP_MODEL_LOAD=1`) on every push/PR. `.github/workflows/deploy-modal.yml` is `workflow_dispatch`-only (never triggers automatically) and additionally requires `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET` repo secrets that aren't configured yet.
- **Service-to-service auth**: `apps/web` sends `Authorization: Bearer <SPARK_SERVICE_TOKEN>` on every call to `apps/voice-service` except the health check. Both apps' `.env` files must have the same value. Once Modal is live, point `apps/web`'s `SPARK_TTS_URL` at the Modal URL and update `SPARK_SERVICE_TOKEN` to match the Modal secret — no code changes either side.

## Authentication and quotas

- Set `DATABASE_URL` locally and in production. Prisma/PostgreSQL is authoritative for users, workspaces, memberships, and sessions.
- `AUTH_TOKENS` remains available only as a test/local compatibility adapter.
- Every account receives a personal workspace. Project documents, jobs, generation, exports, and asset downloads enforce workspace ownership.
- Set `ADMIN_OWNER_IDS` to the user IDs allowed to mutate shared style references.
- `PROJECT_MAX_FILES` and `PROJECT_MAX_BYTES` set per-project asset limits.
- Run remote deployments behind TLS and keep bearer tokens out of URLs and logs.

See [the multi-tenant foundation](docs/multi-tenant-foundation.md) for the ownership model and remaining migration work.

## POC stakes
1. Convert pasted narrative text into a controllable visual sequence.
2. Keep recurring characters and worlds recognizable through the selected style references.
3. Keep prompts and images independently editable while preserving version history.
4. Keep serial generation interruptible, resumable, and exportable.

## Intentionally stubbed
- Select `Stub Preview (no API)` to exercise the full image workflow without API keys.
- Stub previews are simple SVG storyboard cards, not generated art.
- Databases, cloud storage, billing, collaboration, and final assembly are deferred.
