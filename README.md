# 🎬 Storyboard Image POC

An online tool that translates raw stories into playable storyboards and produces single videos with synchronized images, video, text, and synthetic voices. Paste in a story, choose an art style, and generate a sequence of scenes complete with visual prompts, AI-rendered images, matching narration, and based on your reference art.

---

## Quick Start

1. **Configure Environment**:
   ```bash
   cp apps/web/.env.example apps/web/.env
   # Add your GEMINI_API_KEY
   ```
2. **Install Dependencies**:
   ```bash
   npm --prefix apps/web install
   ```
3. **Database Setup**:
   ```bash
   docker compose up -d postgres
   npm --prefix apps/web run prisma:migrate:deploy
   ```
4. **Natural TTS Engine (Optional)**:
   ```bash
   npm run setup:piper
   ```
5. **Start Application**:
   ```bash
   npm run dev:web
   ```
6. **Open in Browser**: Navigate to `http://localhost:3000`

---

## Repo Layout & Architecture

This is a monorepo containing two independently run applications:

- **[apps/web/](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/)**: Node.js/Express storyboard platform (deploys to Railway).
- **[apps/voice-service/](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/voice-service/)**: Python/FastAPI + Spark-TTS voice cloning daemon (deploys to Modal).

### Code Organization & Composition
All business logic is modular and covered by unit tests under `apps/web/test/`:
- `server.js` only loads configuration, initializes dependencies, and starts the Express listener.
- `src/app.js` registers middleware and routes.
- Controllers translate incoming HTTP requests.
- Services manage the generation and persistence workflows (with dependencies injected via `src/dependencies.js`).
- Providers interface with external APIs (Gemini, OpenAI, ElevenLabs, etc.).

---

## Features

- **Text & Image Providers**: Powered by `gemini-3.5-flash` and `gemini-3.1-flash-image` (default), with optional fallbacks for OpenAI, Dezgo, and local stubs.
- **Visual References**: Mapped per-style (characters and environments); supports uploading, previewing, and deleting references in the UI.
- **Scene Management**: Reorder scenes, edit/regenerate visual prompts, switch between historical generated image versions, and download assets as a ZIP.
- **Audio & Video Playback**: One synchronized player with audio/video seeking, auto-looping, and silence padding.
- **Asynchronous Execution**: In-process cancellable generation queue (`GET /api/jobs` and `DELETE /api/jobs/:jobId`).
- **Autosave & Persistence**: Storyboards cache in client `localStorage` and sync to server-side JSON files using monotonic revision locks (`409 REVISION_CONFLICT`).

---

## Included Styles

Styles are loaded dynamically from markdown files under `apps/web/styles/`:
- **Basic Cartoon**
- **Cinematic Reality**
- **Dark Gothic**
- **Indie Youtuber**
- **Vox Style**

---

## AI Generation Pipeline & Prompt Strategy

The storyboard generation follows a structured multi-stage flow:

```mermaid
graph TD
    A[Raw Script / Story] -->|splitIntoFragments| B(Scene Fragments)
    B -->|generate - dialogue.service.js| C(Narration & Dialogue Prose)
    C -->|generate - prompt-generation.service.js| D(Action Beat)
    D -->|regenerate - prompt-generation.service.js| E(Visual Prompt)
    E -->|generate - image-generation.service.js| F(Generated Image)
    F -->|generate - video-generation.service.js| G(Generated Video)
```

### Generation Types

| Type | Function | Inputs | Key Constants / Rules |
| :--- | :--- | :--- | :--- |
| **Dialogue/Narration** | Screenplay-to-spoken adaptation | Fragment + Action beat | [dialogue.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/dialogue.service.js): `NARRATION_RULES_ENRICHED`, `NARRATION_RULES_LITERAL` |
| **Action Beats** | Summary of physical action (5–24 words) | Scene fragment | [prompt-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/prompt-generation.service.js): `BEAT_RULES` (Caveman-simple present tense verbs) |
| **Visual Prompts** | Camera-agnostic layout prompt (15–40 words) | Beat + Neighbors | [prompt-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/prompt-generation.service.js): `CONTINUITY_RULE` + Neighboring scene context |
| **Image Generation** | Renders keyframe images | Visual prompt + Style + References | [image-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/image-generation.service.js): Injects up to 14 character/world reference paths |
| **Video Generation** | Animates static images | Image + Motion instructions | [video-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/video-generation.service.js): `INTENSITY_MOTION_PROMPTS`, `STYLE_MOTION_PROMPTS` |
| **Voice / Audio** | Synthesizes voiceovers from text | Narration text | [voice.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/voice.service.js): Piper (local), ElevenLabs (cloud), Spark-TTS (clone) |

### Developer Tuning Guide

#### 1. Invalidate Cache After Updates
The application caches prompt generation outputs. If you modify any service templates or prompt rules, you **must** increment these version flags:
- In [prompt-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/prompt-generation.service.js): Increment `PROMPT_TEMPLATE_VERSION` and `ACTION_TEMPLATE_VERSION`.
- In [dialogue.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/dialogue.service.js): Increment `NARRATION_TEMPLATE_VERSION`.

#### 2. Creating & Editing Styles
Create style templates under `apps/web/styles/<style-id>.md`:
* Line 1 **must** be a header (e.g., `# Dark Gothic`).
* Subsequent lines define the visual styling prompts (e.g., contrast, outlines, silhouettes).

#### 3. Image Reference Configuration
Configure default style reference images by creating directories:
- **Characters**: `apps/web/style-references/<style-id>/characters/`
- **World/Environment**: `apps/web/style-references/<style-id>/world/`
*Supported formats: PNG, JPG, WebP, GIF. Sorted alphabetically (up to 8 per category).*

#### 4. Adjusting Prompt Word Budgets
If you need to fine-tune character limits or prompt lengths, update:
- **Video Prompts**: Update `VIDEO_PROMPT_WORD_BUDGET` in [video-generation.service.js](file:///Ubuntu/home/administrator/web/basic-cartoon-poc/apps/web/src/services/video-generation.service.js).
- **Visual Prompts**: Update `limits.prompt` in the dependency injection configuration (which maps to limits enforced in `prompt-generation.service.js`).

---

## Voice & TTS Engines

### Local TTS (Zero-API-Key)
- **Local Fallback**: Rudimentary offline voice synthesis.
- **Piper TTS**: High-quality natural neural TTS. Setup: `npm run setup:piper` (downloads engine/voice files into `apps/web/vendor/piper/`).

### Voice Cloning (Spark-TTS)
A zero-shot, commercial-safe cloning daemon located in `apps/voice-service/`. Requires an NVIDIA GPU (tested on RTX 3060, 12GB VRAM).

1. **Setup**:
   ```bash
   npm run setup:spark  # Installs PyTorch, venv, and downloads 4GB models
   ```
2. **Configuration**: 
   Copy `apps/voice-service/.env.example` to `apps/voice-service/.env`. Ensure `SPARK_SERVICE_TOKEN` matches the token in `apps/web/.env`.
3. **Execution**:
   ```bash
   npm run dev:voice   # Starts FastAPI server on http://localhost:8001
   ```
- Cloned voices are stored under `apps/voice-service/voices/<voiceId>/` and are reusable across storyboards.

---

## Storage & API Operations

- **Storyboard/Project Assets**: Storyboards are stored in `apps/web/data/projects/<project-id>/project.json` and generated assets are saved under `/assets/<type>`.
- **API Jobs**: Responses include an `X-Generation-Job-Id`. Management endpoints:
  - `GET /api/jobs` (list active)
  - `DELETE /api/jobs/:jobId` (cancel)
- **Cleanup**: `POST /api/projects/:projectId/cleanup` garbage-collects orphaned assets.

---

## Authentication & Pricing Setup

### 1. Bootstrapping Admin Access
Assign administrative roles using a bootstrap list of user IDs in `apps/web/.env`:
```dotenv
ADMIN_OWNER_IDS=00000000-0000-0000-0000-000000000000
```
**Assign Role Sequence**:
1. Register an account at `http://localhost:3000/login.html?mode=register`.
2. Extract the user's UUID:
   ```bash
   docker compose exec postgres psql -U storyboard -d storyboard -c 'SELECT id, email, platform_role FROM users ORDER BY created_at;'
   ```
3. Update `ADMIN_OWNER_IDS` in `.env` and restart `apps/web`. The user can now access `/admin`.

### 2. Stripe Checkout (Credit Purchases)
To activate one-time credit purchases, configure Stripe environment variables:
```dotenv
PUBLIC_APP_URL=http://localhost:3000
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```
- Forward Stripe webhooks locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
- Enable/disable deductions with `BILLING_CUSTOMER_CHARGING_ENABLED=true/false`.
- Publish seeded pricing tiers (Starter, Creator, Studio) from **Admin → Pricing & sales**.

---

## Deployment Configuration

- **`apps/web` (Railway)**: Dockerfile and `railway.toml` are configured. Set the **Root Directory** to `apps/web` in the Railway dashboard.
- **`apps/voice-service` (Modal)**: Deploys using `modal deploy apps/voice-service/modal_app.py`. Set secrets on Modal: `SPARK_SERVICE_TOKEN`, `SPARK_TEMPERATURE`.
- **CI**: GitHub actions run code checks and mock voice inference. Production deployment requires `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` secrets.
