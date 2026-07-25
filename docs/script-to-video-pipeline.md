# Script → Video Pipeline

Developer reference for how a project moves from source script to narrated scenes, stills, audio, and video — including where style files inject into prompts.

Primary code:

- Planning: `apps/web/src/services/shot-planning.service.js`
- Narration rules: `apps/web/src/services/dialogue.service.js`
- Images: `apps/web/src/services/image-generation.service.js`
- Video: `apps/web/src/services/video-generation.service.js`
- Styles: `apps/web/src/services/styles.service.js`
- Studio Start/Replan: `apps/web/public/js/generation/stages.js`, `workflows.js`

---

## End-to-end flow

```text
Source script
    │
    ▼
┌───────────────────────┐
│ 1. Narrate (chunked)  │  ~900 words / call
│    STYLE VOICE        │  writing.md
│    + enrich/literal   │
└───────────┬───────────┘
            │ finished spoken narration
            ▼
┌───────────────────────┐
│ 2. Segment (chunked)  │  ~300 words / call
│    STYLE CUTS         │  orchestrator.md
│    + density soft tgt │  ~45 words / scene
└───────────┬───────────┘
            │ scene list (count locked)
            ▼
┌───────────────────────┐
│ 3. Plan visuals       │  per scene batch
│    style.md (look)    │  visualPrompt + actionPrompt/beat
└───────────┬───────────┘
            │
            ├──────────────► 4. Image gen   (style.md + scene visual prompt + refs)
            ├──────────────► 5. Audio gen   (scene narrationText)
            ├──────────────► 6. Subtitles   (aligned audio words)
            └──────────────► 7. Video gen   (start still + beat/motion + truncated style)
```

**When structure is created**

| Trigger | What runs |
|---|---|
| Empty board → **Start** | Full prepare narration → plan visuals → then media stages as configured |
| **Replan** | Rebuild narration boundaries + visuals (archives displaced scenes) |
| Existing board → Start | Fill/refresh prompts only — does **not** rebuild scene structure |
| Per-scene regenerate | Image / audio / video / prompt / dialogue without re-segmenting |

Scene count is decided in **step 2**. Later stages do not add or remove scenes unless the user splits/replans.

---

## Style system

Each system style lives in one folder:

```text
apps/web/style-references/<style-id>/
  style.md           # visual look (image + visual planning + video baseline)
  writing.md         # STYLE VOICE — narration tone/density
  orchestrator.md    # STYLE CUTS — scene segmentation grammar
  characters/        # optional style reference images
  world/             # optional style reference images
```

Custom styles store `promptText` + `writingGuidance` in the DB (visual + voice). Orchestrator for customs is empty unless added later.

### System styles (roles)

| Style id | Visual intent | Writing (voice) | Orchestrator (cuts) |
|---|---|---|---|
| `basic-cartoon` | Stick figures, sparse icons | Spare action sentences | One pose/prop action per card |
| `cinematic-reality` | Photoreal film depth | Filmic sensory narration | Establish → act → react |
| `dark-gothic` | Rated-R mixed-media horror | Visceral concrete dread | One scare focus per card |
| `indie-youtuber` | Talking-head / PiP vlog | Creator-to-camera | Hook / react / explain / B-roll |
| `vox-style` | Editorial explainer collage | Claim then clarifying detail | One teaching point per card |
| `corporate-presentation` | Readable enterprise slides | Presenter, slide-ready specifics | One claim/slide/evidence beat |

Companion files use a low-cognition template:

- **writing.md** — `Voice` / `Do` / `Don't`
- **orchestrator.md** — `Unit` / `Cut on` / `Prefer` / `Never`

---

## Stage 1 — Narration

**Service:** `narrateScript` → `buildNarrateChunkRequest`  
**Chunking:** script split at ~900 words (`MAX_WORDS_PER_NARRATION_CHUNK`)  
**Output:** continuous spoken narration (joined across chunks)

### Prompt inject order

1. **Source-of-truth** — enrich may add sensory detail; never invent plot/characters/dialogue
2. **STYLE VOICE** — `writing.md` / custom `writingGuidance` (primary tone & density)
3. **NARRATION RULES** — project override `narrationPromptText`, else enrich or literal defaults from `dialogue.service.js`
4. **USER GUIDANCE** — optional Settings guidance (+ helper chips)
5. **Script excerpt**

### Settings that matter

| Setting | Effect |
|---|---|
| Narration-driven (`enrich` on) | Enriched / cinematic adaptation rules |
| Script-driven (`enrich` off) | Literal read-through rules |
| Style selection | Injects that style’s `writing.md` |
| Narration guidance / helpers | Soft tone/pacing only |

**Note:** Both planning modes still **segment from finished narration**. Enrich mainly changes how wordy/atmospheric the narration is before cuts.

---

## Stage 2 — Scene segmentation

**Service:** `prepareNarration` → `buildNarrationSegmentationRequest`  
**Chunking:** narration re-split at ~300 words (`MAX_WORDS_PER_SHOT_CHUNK`)  
**Output:** ordered scenes with `narrationText` + aligned `sourceScriptFragment`

### Prompt inject order

1. **HARD RULES** — exact copy of narration; exact source alignment; no invented prompts
2. **Soft density** — `ceil(words / 45)` segments per chunk (~15–20s speech). Optional project shot limit is a soft ceiling, hard-trimmed after if exceeded
3. **STYLE CUTS** — `orchestrator.md` as **primary** cut grammar when present
4. Thin fallback only if orchestrator is silent (or full DEFAULT CUTS if no orchestrator)
5. Narration excerpt + source excerpt

Chunk size is for model reliability, **not** “1 chunk = 1 scene.” The model returns N segments per chunk; totals concatenate.

---

## Stage 3 — Visual / beat planning

**Service:** `planVisuals` → `buildVisualPlanningRequest`  
**Output:** per scene `prompt` (visual) + `beat` (physical action), also written to `shots[0].prompt`

### Prompt injects

- Per-scene narration (+ source if different)
- Neighbor narration (continuity only)
- Established setting (sluglines + early narration)
- **Style context:** `style.md` / `promptText` (look seasoning)
- Additional common prompt (studio common field minus duplicated style text)
- Fixed VISUAL / ACTION rules (still description + motion-friendly beat)

Does **not** change scene count.

---

## Stage 4 — Image generation

**Service:** `image-generation.service.js`

### Composed image prompt

```text
style.md promptText
+ additional common (if any)
+ scene visual prompt
+ optional extra prompt
```

### References

- Style refs from `characters/` + `world/` (capped; optional disable per scene)
- Scene/shot reference bindings (priority)

Sparse styles (e.g. stick figures) often benefit from style refs; photoreal/cinematic styles usually stay text-only to avoid remixing one locked frame.

---

## Stage 5 — Audio & subtitles

- **Audio:** TTS/clone from `scene.narrationText` (provider-specific)
- **Subtitles:** derived from aligned word timings on the active audio version

No style `.md` injects here beyond whatever already shaped the narration text.

---

## Stage 6 — Video generation

**Service:** `buildVideoPrompt` in `video-generation.service.js`  
**Typical input:** start frame = active generated still (I2V)

### Composed video prompt (word-budget clipped)

1. **Story action** — planned beat (preferred motion core)
2. **Motion direction** — override → beat → intensity filler, plus short style-motion seasoning tag
3. **Scene visual prompt** — truncated still description
4. **Style baseline** — truncated `style.md` (small budget; look mostly lives in the start frame)
5. **Additional style direction** — common prompt remainder

Video does **not** re-run orchestrator/writing. Those already decided cuts and spoken text upstream.

---

## Prompt ownership map

| Artifact | Owns |
|---|---|
| `style.md` | How frames **look** (image + visual plan + light video baseline) |
| `writing.md` | How narration **sounds** |
| `orchestrator.md` | How narration is **cut** into scenes |
| Enrich / literal rules | Global narration adaptation policy |
| Soft density (~45 w/scene) | Baseline spoken pacing for cut count |
| Scene visual prompt / beat | Per-card still + motion intent |
| Style/scene reference images | Identity / look lock at image time |

---

## Studio UX mapping

| UI control | Pipeline hook |
|---|---|
| Style picker | Loads `style.md` + `writing.md` + `orchestrator.md` (+ refs) |
| Visual planning: Script- / Narration-driven | `enrich` off / on |
| Narration style + guidance | Base rules override + USER GUIDANCE |
| Shot limit | Segmentation soft ceiling + post-merge trim |
| Common prompt | Appended look direction for image/visual/video |
| Custom styles modal | `promptText` + writing guidance (visual + voice) |

---

## Design principles (current)

1. **Narrate → cut → visualize** — structure comes from spoken narration, not from guessing scene count upfront
2. **Style is three axes** — look / voice / cuts stay in separate files so they don’t fight
3. **Mechanical vs taste** — hard rules stay copy/alignment; taste lives in STYLE VOICE / STYLE CUTS
4. **Density follows speech** — longer enriched narration should yield more cards (~45 words/scene soft target)
5. **Video inherits the still** — I2V motion is beat-led; full style essay is not re-sent

---

## Key constants

| Constant | Value | Where |
|---|---|---|
| Narration chunk | ~900 words | `MAX_WORDS_PER_NARRATION_CHUNK` |
| Segmentation chunk | ~300 words | `MAX_WORDS_PER_SHOT_CHUNK` |
| Words per scene soft target | 45 | `TARGET_WORDS_PER_SCENE` |
| Companion prompt cap | 1000 chars | styles + planning cleanText |
| Script max | 200k chars | schemas / cleanText |

---

## Related docs

- `docs/reference-image-deep-dive.md` — style vs scene references
- `docs/media-output-policy.md` — aspect / duration / provider output
- `apps/web/docs/frontend-javascript.md` — studio frontend layout
