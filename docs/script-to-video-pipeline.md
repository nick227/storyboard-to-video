# Script → Video Pipeline

Complete developer reference for every AI / provider call from source script to finished video: prompts, injects, generated artifacts, and how they chain.

---

## Artifact chain (how prompts work together)

```text
scriptText
    │
    │  [A] narration.plan          (chunked)
    ▼
narrationText  (+ STYLE VOICE from writing.md)
    │
    │  [B] narration.segment       (chunked)
    ▼
scenes[] {
  narrationText,           ← exact slice of narration
  sourceScriptFragment,    ← aligned script slice
}
    │
    │  [C] visual.plan             (batched)
    ▼
scenes[] {
  …prior fields,
  beat,                    ← actionPrompt (still / image physical action)
  prompt / shots[0].prompt ← visualPrompt (still description)
  videoPrompt,             ← I2V motion brief (action-first)
}
    │
    ├─[D] image.generate ──────────► still image versions
    │      inputs: style.md + scene.prompt + refs
    │
    ├─[E] audio.generate ──────────► audio versions
    │      input: scene.narrationText
    │      optional align (WhisperX) → words[]
    │
    ├─[F] subtitle.generate ───────► SRT from alignment words
    │      (no LLM)
    │
    └─[G] video.generate ──────────► video versions
           inputs: start still + videoPrompt (or beat fallback)
```

**Rule of thumb:** upstream text AI calls *produce* fields that later media calls *consume*. Style companions inject at different layers:

| Companion | Injects into |
|---|---|
| `writing.md` | [A] narration only |
| `orchestrator.md` | [B] segmentation only |
| `style.md` | [C] visual plan, [D] image |

---

## Style pack layout

```text
apps/web/style-references/<style-id>/
  style.md           # look
  writing.md         # STYLE VOICE
  orchestrator.md    # STYLE CUTS
  characters/        # optional refs
  world/             # optional refs
```

Loaded by `styles.service.js`. Custom styles: DB `promptText` + `writingGuidance`; orchestrator empty today.

| Style | Look | Voice | Cuts |
|---|---|---|---|
| `basic-cartoon` | Stick figures | Spare action | Pose/prop unit |
| `cinematic-reality` | Photoreal film | Filmic sensory | Establish/act/react |
| `dark-gothic` | Horror mixed media | Visceral dread | Scare focus |
| `indie-youtuber` | Talking-head / PiP | Creator-to-camera | Vlog beats |
| `vox-style` | Explainer collage | Claim → detail | Teaching point |
| `corporate-presentation` | Enterprise slides | Presenter, concrete | Claim/slide/evidence |

---

## Primary studio path (Start / Replan)

| Trigger | Calls |
|---|---|
| Empty board → Start | [A] → [B] → [C] → media stages as configured |
| Replan | [A] → [B] → [C] (archives displaced scenes) |
| Existing board → Start | Prompt/media fill only — **no** [A]/[B] rebuild |

Routes: `POST /api/storyboard/prepare-narration`, `POST /api/storyboard/plan-visuals`  
Code: `shot-planning.service.js` (`prepareNarration`, `planVisuals`)  
UI: `workflows.js` / `stages.js`

---

## Call catalog

Legend:

- **Kind:** `text` = LLM JSON/text · `image` = image model · `tts` = speech · `align` = forced alignment · `video` = I2V / video model · `none` = deterministic
- **Cache op:** generation-cache fingerprint key when used

---

### [A] Narration plan — `narration.plan`

| | |
|---|---|
| **Kind** | text |
| **When** | prepare-narration / plan-shots |
| **Chunking** | ~900 words of **script** per call |
| **Builder** | `buildNarrateChunkRequest` |
| **Returns** | `{ narrationText }` per chunk → joined |

**Prompt stack (order):**

1. Source-of-truth (enrich may add sensory detail; no invented plot)
2. **STYLE VOICE** ← `writing.md` / custom writing guidance
3. **NARRATION RULES** ← project `narrationPromptText` override, else enrich or literal defaults (`dialogue.service.js`)
4. **USER GUIDANCE** ← Settings guidance (+ helper chips)
5. Script excerpt

**Consumes:** `scriptText`, style writing, enrich flag, guidance  
**Produces:** full-project `narrationText` (and per-chunk source mapping)

---

### [B] Narration segment — `narration.segment`

| | |
|---|---|
| **Kind** | text |
| **When** | prepare-narration (after [A]) |
| **Chunking** | ~300 words of **narration** per call |
| **Builder** | `buildNarrationSegmentationRequest` |
| **Returns** | `{ segments: [{ sourceScriptFragment, narrationText }] }` |

**Prompt stack:**

1. **HARD RULES** — exact copy of narration; exact source alignment; no invented prompts
2. Soft density — `ceil(words / 45)` (~15–20s speech); optional shot-limit soft ceiling
3. **STYLE CUTS** ← `orchestrator.md` (primary when present)
4. Thin fallback if cuts silent (or DEFAULT CUTS if no orchestrator)
5. Narration excerpt + source excerpt

**Consumes:** output of [A]  
**Produces:** scene list — **locks scene count** (unless later split/replan)

---

### [C] Visual plan — `visual.plan`

| | |
|---|---|
| **Kind** | text |
| **When** | plan-visuals |
| **Batching** | scenes in batches |
| **Builder** | `buildVisualPlanningRequest` |
| **Returns** | `{ visuals: [{ sceneNumber, visualPrompt, actionPrompt, videoPrompt }] }` |

**Prompt stack:**

1. Fixed VISUAL + ACTION + VIDEO rules (still description; still action; I2V motion brief)
2. Established setting (sluglines + early narration)
3. **Style context** ← `style.md` / `promptText`
4. Additional common prompt
5. Per scene: narration, optional source, neighbor continuity

**Consumes:** scenes from [B], `style.md`  
**Produces:** `scene.prompt` / `shots[0].prompt`, `scene.beat`, `scene.videoPrompt`  
**Does not** change scene count.

[C] does three jobs in one call (still description, still action, video motion). That is acceptable while the JSON schema stays strict and each field remains independently recoverable (regen beat vs regen visual vs replan visuals for motion). Style enters `videoPrompt` only as light motion seasoning inside the planned string — never as a second visual/style dump at [G].

System rules (inline in service):

- `visualPrompt`: 15–40 words, subject/pose/object/location/composition; carry setting; no motion/style wording
- `actionPrompt` / `beat`: 8–28 words — **what the still depicts** (pose/gesture)
- `videoPrompt`: ~25–60 words — **what changes during playback**; action first, then light environment/style motion; do not restate look

---

### [D] Image generate — `image.generate`

| | |
|---|---|
| **Kind** | image (+ text parts for Gemini refs) |
| **When** | image stage / regenerate image |
| **Route** | `POST /api/images/generate` |
| **Service** | `image-generation.service.js` |

**Composed text prompt:**

```text
style.md promptText
+ additional common (studio common minus duplicated style)
+ scene visual prompt          ← from [C]
+ optional extra prompt
```

**Reference parts (when present):** style `characters/` + `world/` (capped) and/or scene reference bindings. Gemini prepends role instructions (`CHARACTER IDENTITY`, `LOCATION IDENTITY`, `COMPOSITION`, `PREVIOUS SHOT CONTINUITY`) via `providers/text.geminiParts`.

**Consumes:** [C] prompt + style look + refs  
**Produces:** image version on the scene/shot

---

### [E] Audio generate

| | |
|---|---|
| **Kind** | tts (+ optional align) |
| **When** | audio stage / regenerate audio / recording upload |
| **Route** | `POST /api/audio/generate` (and recording upload path) |
| **Service** | `audio-generation.service.js` |

**Input:** `scene.narrationText` from [A]/[B] (not an LLM prompt).  
**Optional:** alignment provider (WhisperX) with audio + transcript → `version.alignment.words`.

**Produces:** audio version; may attach alignment metadata

---

### [F] Subtitle generate

| | |
|---|---|
| **Kind** | none (deterministic) |
| **When** | subtitle stage |
| **Route** | `POST /api/subtitles/generate` |
| **Service** | `subtitle-generation.service.js` |

Builds cues/SRT from active audio alignment words. Requires prior [E] alignment. No LLM.

---

### [G] Video generate — `video.generate`

| | |
|---|---|
| **Kind** | video (I2V / provider-specific) |
| **When** | video stage / regenerate video |
| **Route** | `POST /api/videos/generate` |
| **Builder** | `buildVideoPrompt` |

**Video prompt:** single motion string — `motionPrompt` override → env `VIDEO_MOTION_PROMPT` → planned `scene.videoPrompt` from [C] → `scene.beat` → intensity filler. `videoPrompt` is planned separately from still `actionPrompt`/`beat`: action first, then light environment/style motion. Look stays in the start frame; providers clamp length (e.g. MiniMax 2000 chars).

**Media:** start frame = active still from [D] (typical MiniMax/Gemini I2V path).  
**Consumes:** [C] videoPrompt (or beat fallback) + [D] still  
**Produces:** video version

---

## Secondary / per-scene AI calls

### [H] Regenerate dialogue — `narration.regenerate`

| | |
|---|---|
| **Kind** | text |
| **Route** | `POST /api/storyboard/regenerate-dialogue` |
| **Builder** | `buildRegenerateRequest` (`dialogue.service.js`) |

**Prompt:** source-of-truth → narration rules / project narration prompt → optional instruction → scene source block → current narration.  
**Produces:** new `scene.narrationText` (does not auto re-run [B]/[C]; visuals/audio may go stale).

---

### [I] Regenerate visual prompt — `prompt.regenerate`

| | |
|---|---|
| **Kind** | text |
| **Route** | `POST /api/storyboard/regenerate-prompt` |
| **Service** | `prompt-generation.service.js` |

**Prompt:** new visual from canonical narration (else script fragment) + beat + continuity rule + `style.md` + common + optional user instruction. **Does not** feed the previous prompt.  
**Produces:** new `scene.prompt` / shot prompt.

---

### [J] Regenerate action (beat) — `action.regenerate`

| | |
|---|---|
| **Kind** | text |
| **Route** | `POST /api/storyboard/regenerate-action` |

**Prompt:** rewrite physical beat 8–28 words from script fragment + BEAT RULES (dynamic verbs, source-faithful).  
**Produces:** new `scene.beat` (still/image action; [G] falls back to beat only if `videoPrompt` is empty).

---

### [K] Split scene — `scene.split`

| | |
|---|---|
| **Kind** | text |
| **Route** | `POST /api/storyboard/split-scene` |
| **Builder** | `buildSplitRequest` |

**Prompt:** divide one scene into N children; `scriptFragment` + `narrationText` must reconstruct sources **verbatim**; only `beat` is freshly generated.  
**Produces:** N replacement scenes (structure change without full replan).

---

## Alternate / legacy planning path

### [L] Plan-shots monolith — **DEPRECATED**

> Deprecated. Do not extend. Studio Start/Replan use **prepare-narration + plan-visuals** ([A][B][C]) only. `POST /api/storyboard/plan-shots` / `shotPlanning.plan()` remains for tests and old clients until removed.

`shotPlanning.plan()` still exists: narrate ([A]-like) → **sequence.scan** → **shot.plan** chunks that emit narration+visual+action(+video) together.

| Cache op | Role |
|---|---|
| `sequence.scan` | Broad sequence labels/intents over full narration (tone context only) |
| `shot.plan` | Per ~300-word narration chunk → shots with narration + visual + action + video |

Treat [L] as a frozen alternate pipeline — not a second evolving path.

### Internal helpers (not primary Start path)

| Service method | Notes |
|---|---|
| `dialogue.generate` (batch) | Per-scene narration from fragments; kept/tested; not the main Start path |
| `prompts.generate` (batch) | Fragment→beat/prompt batch; superseded by `visual.plan` for Start |

---

## Library / style tooling AI calls

### [M] Script → reference visual brief

| | |
|---|---|
| **Kind** | text |
| **Service** | `reference-generation.service.js` |
| **When** | project image library “generate reference” flow |

Modes: character-reference / world-reference / generic scene — 30–80 word visual description JSON `{ prompt }`, no style wording. Then an **image** generate uses that prompt + style.

### [N] Custom style reference image

| | |
|---|---|
| **Kind** | image |
| **Route** | `POST /api/custom-styles/:id/references/generate` |

**Prompt:** `style.promptText` + fixed character-sheet or world-establishing suffix. No writing/orchestrator.

---

## Providers (non-prompt transport)

| Modality | Typical providers | Prompt notes |
|---|---|---|
| Text | Gemini, OpenAI, stub | JSON extracted from model text |
| Image | Gemini, OpenAI, Dezgo, stub | Text prompt + optional reference images |
| Audio | stub TTS, Piper, Spark, ElevenLabs | Raw narration string |
| Align | WhisperX alignment service | Audio bytes + transcript |
| Video | MiniMax, LTX, Veo, stub | `buildVideoPrompt` + start (and optional end) frame |

Stub providers skip network and return deterministic local fallbacks.

---

## Settings → inject map

| UI | Affects calls |
|---|---|
| Style picker | [A] writing, [B] orchestrator, [C][D] style.md + refs ([G] inherits look via start still only) |
| Script- / Narration-driven | [A] enrich off/on (and some regenerate source preference) |
| Narration style / prompt editor | [A]/[H] base rules override |
| Narration guidance / helpers | [A] USER GUIDANCE |
| Shot limit | [B] soft ceiling + post-merge trim |
| Common prompt | [C][D] additional look direction (not composed into [G]) |
| Motion intensity | [G] intensity filler when no videoPrompt/beat/override |
| Image / audio / video provider | Which backend executes [D][E][G] |

---

## Generated field ownership

| Field | Created by | Consumed by |
|---|---|---|
| `narrationText` | [A] then sliced by [B]; or [H] | [C][E][I][K], audio alignment |
| `sourceScriptFragment` | [B] / [K] | [C] continuity, regenerate fallbacks |
| `beat` | [C] / [J] / [K] | Still action (what the still depicts); [I] cue; [G] fallback if no `videoPrompt` |
| `videoPrompt` | [C] | [G] primary motion (what changes in playback). Cleared/stale when beat or narration changes |
| `prompt` / `shots[0].prompt` | [C] / [I] | [D] image |
| Image version | [D] | [G] start frame; UI |
| Audio version + alignment | [E] | [F] subtitles; playback |
| Subtitle version | [F] | export / playback |
| Video version | [G] | export / playback |

---

## Constants

| Name | Value | Used by |
|---|---|---|
| `MAX_WORDS_PER_NARRATION_CHUNK` | 900 | [A] |
| `MAX_WORDS_PER_SHOT_CHUNK` | 300 | [B], shot.plan |
| `TARGET_WORDS_PER_SCENE` | 45 | [B] density |
| Companion cleanText cap | 1000 | writing / orchestrator |
| Script max | 200k chars | schemas |
| Visual plan batch | service batching | [C] |
| Dialogue / prompt legacy batch | 5 | helpers |

---

## Code map

| Area | Path |
|---|---|
| Narrate / segment / visual plan | `apps/web/src/services/shot-planning.service.js` |
| Enrich/literal + regenerate dialogue | `apps/web/src/services/dialogue.service.js` |
| Regenerate prompt/action | `apps/web/src/services/prompt-generation.service.js` |
| Split scene | `apps/web/src/services/scene-split.service.js` |
| Image | `apps/web/src/services/image-generation.service.js` |
| Audio | `apps/web/src/services/audio-generation.service.js` |
| Subtitles | `apps/web/src/services/subtitle-generation.service.js` |
| Video + `buildVideoPrompt` | `apps/web/src/services/video-generation.service.js` |
| Style load | `apps/web/src/services/styles.service.js` |
| Reference brief | `apps/web/src/services/reference-generation.service.js` |
| Gemini ref role text | `apps/web/src/providers/text/index.js` |
| Studio orchestration | `apps/web/public/js/generation/stages.js`, `workflows.js` |
| Style packs | `apps/web/style-references/<id>/` |

---

## Related

- `docs/reference-image-deep-dive.md`
- `docs/media-output-policy.md`
- `apps/web/docs/frontend-javascript.md`
