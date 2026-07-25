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
  beat,                    ← actionPrompt (physical action)
  prompt / shots[0].prompt ← visualPrompt (still description)
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
           inputs: start still + beat + motion + truncated style.md
```

**Rule of thumb:** upstream text AI calls *produce* fields that later media calls *consume*. Style companions inject at different layers:

| Companion | Injects into |
|---|---|
| `writing.md` | [A] narration only |
| `orchestrator.md` | [B] segmentation only |
| `style.md` | [C] visual plan, [D] image, [G] video (truncated) |

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
| **Returns** | `{ visuals: [{ sceneNumber, visualPrompt, actionPrompt }] }` |

**Prompt stack:**

1. Fixed VISUAL + ACTION rules (still description; motion-friendly beat)
2. Established setting (sluglines + early narration)
3. **Style context** ← `style.md` / `promptText`
4. Additional common prompt
5. Per scene: narration, optional source, neighbor continuity

**Consumes:** scenes from [B], `style.md`  
**Produces:** `scene.prompt` / `shots[0].prompt`, `scene.beat`  
**Does not** change scene count.

System rules (inline in service):

- `visualPrompt`: 15–40 words, subject/pose/object/location/composition; carry setting; no motion/style wording
- `actionPrompt`: 8–28 words, present-tense physical action; dynamic verbs; source-faithful

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

**Composed video prompt (word budgets):**

| Block | Source | Budget |
|---|---|---|
| Story action | `scene.beat` from [C] | 28 words |
| Motion direction | motion override → beat → intensity filler + style-motion seasoning | 36 |
| Scene visual prompt | `scene.prompt` from [C] | 28 |
| Style baseline | `style.md` truncated | 40 |
| Additional style | common remainder | 5 |

Hardcoded style-motion seasoning tags (`STYLE_MOTION_PROMPTS`) by style id (e.g. comic snap, grounded weight, crisp cutout slides). Corporate presentation falls back to generic “Clear readable motion.” if unset.

**Media:** start frame = active still from [D] (typical MiniMax/Gemini I2V path).  
**Consumes:** [C] beat/prompt + [D] still + truncated style  
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
**Produces:** new `scene.beat` (feeds later [G] motion).

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

### [L] Plan-shots monolith — `POST /api/storyboard/plan-shots`

`shotPlanning.plan()` still exists: narrate ([A]-like) → **sequence.scan** → **shot.plan** chunks that emit narration+visual+action together.

| Cache op | Role |
|---|---|
| `sequence.scan` | Broad sequence labels/intents over full narration (tone context only) |
| `shot.plan` | Per ~300-word narration chunk → shots with narration + visual + action |

Studio Start/Replan prefer **prepare-narration + plan-visuals** ([A][B][C]). Treat [L] as alternate/legacy bundled planning.

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
| Style picker | [A] writing, [B] orchestrator, [C][D][G] style.md, refs |
| Script- / Narration-driven | [A] enrich off/on (and some regenerate source preference) |
| Narration style / prompt editor | [A]/[H] base rules override |
| Narration guidance / helpers | [A] USER GUIDANCE |
| Shot limit | [B] soft ceiling + post-merge trim |
| Common prompt | [C][D][G] additional look direction |
| Motion intensity | [G] intensity filler when no beat/override |
| Image / audio / video provider | Which backend executes [D][E][G] |

---

## Generated field ownership

| Field | Created by | Consumed by |
|---|---|---|
| `narrationText` | [A] then sliced by [B]; or [H] | [C][E][I][K], audio alignment |
| `sourceScriptFragment` | [B] / [K] | [C] continuity, regenerate fallbacks |
| `beat` | [C] / [J] / [K] | [G] motion core; [I] action cue |
| `prompt` / `shots[0].prompt` | [C] / [I] | [D] image; [G] visual block |
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
