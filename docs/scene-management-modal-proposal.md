# Scene Management Modal — Design Proposal

## Summary

Replace the row of six entity icons plus the delete icon on every scene card with one clearly labeled **Manage scene** button. The button retains at-a-glance progress through a short text summary, while the modal acts as the scene's generation controller: users can understand, configure, and run every entity from one ordered workflow.

The design should answer four questions without requiring the user to decode color or open a second inspector:

1. What exists for this scene?
2. Which source and settings produced it?
3. What needs attention, and why?
4. What can I generate, regenerate, update, retry, or change here?

The internal concept of “stale” remains useful, but the interface should call it **Needs update** and state the input that changed.

The repeated interaction pattern is:

> **Entity → source/config → status → primary action**

## Goals

- Replace seven ambiguous icon targets with one predictable entry point.
- Preserve quick scanning across many scene cards.
- Show the complete state of one scene in a single view.
- Give every generated text or media entity the same status and action model.
- Keep Generate, Regenerate, Update, or Retry visible on every row without hover or expansion.
- Show the resolved provider, model, voice, media settings, and other key inputs that explain each output.
- Let users override generation settings for this entity in this scene without confusing them with project-wide defaults.
- Explain outdated output in plain language and show the dependency that caused it.
- Make generation and regeneration discoverable without making costly actions easy to trigger accidentally.
- Surface the original script fragment as stable context.
- Move scene deletion into a deliberate, clearly separated action.

## Non-goals

- Redesigning the project-wide generation stages or batch workflow.
- Turning the modal into a full node graph or technical job inspector.
- Showing raw hashes, manifests, provider payloads, or other implementation details by default.
- Automatically regenerating downstream entities after an edit.
- Replacing project-wide Settings; the modal consumes those defaults and links back to the appropriate Settings section.

## Entry point on the scene card

Use one full-width or compact text button in the current `.scene-status` area:

> **Manage scene** · 5/7 ready · 1 update

On narrow cards:

> **Manage** · 5/7

The generated-entity count covers:

1. Physical action
2. Visual prompt
3. Narration
4. Image
5. Audio
6. Video
7. Subtitles

The source script is not counted because it is an input, not a generated result.

### Summary rules

The button should use text plus an icon or shape; color is supplemental.

- All ready: `7/7 ready`
- Some missing: `4/7 ready`
- Outdated output: `5/7 ready · 2 updates`
- Failed attempt: `5/7 ready · 1 failed`
- Work in progress: `Generating 1 of 7`
- Empty scene: `Not started`

When more than one exceptional state exists, show the highest-priority state on the card and the complete breakdown in the modal. Recommended priority:

1. Failed
2. Generating
3. Needs update
4. Not created
5. Ready

The entire button opens the same modal. There are no hidden click meanings based on icon color.

## Modal structure

Desktop width should be approximately 760–840 px, with a maximum height of 90 vh. On mobile it becomes a full-height sheet. The header and optional bottom action area remain visible while the rows scroll.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ SCENE 04 · The visitor arrives                              Previous Next  ✕ │
│ 5 of 7 ready · 1 needs update · 1 not created                              │
├───────────────┬────────────────────────────┬──────────────┬──────────────────┤
│ ENTITY        │ SOURCE / CONFIG            │ STATUS       │ PRIMARY ACTION   │
├───────────────┴────────────────────────────┴──────────────┴──────────────────┤
│ Source script · “The visitor steps through the doorway…”      Source   View │
├───────────────┬────────────────────────────┬──────────────┬──────────────────┤
│ Physical      │ Gemini · Flash             │ Ready        │ [Regenerate]     │
│ action        │ Project default · Change…  │ 8 min ago    │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Visual prompt │ Gemini · Flash             │ Ready        │ [Regenerate]     │
│               │ Project default · Change…  │ 2 versions   │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Narration     │ OpenAI · GPT-5 mini        │ Ready        │ [Regenerate]     │
│               │ Scene override · Change…   │ 3 versions   │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Image         │ Gemini · Imagen · 16:9     │ Ready        │ [Regenerate]     │
│ [thumbnail]   │ Project default · Change…  │ 4 versions   │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Audio         │ ElevenLabs · Voice: Ava    │ Needs update │ [Update]         │
│ [play]        │ Scene override · Change…   │ Narration    │                  │
│               │                            │ changed      │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Video         │ Veo 3.1 · 720p · 8 sec     │ Not created  │ [Generate]       │
│               │ Project default · Change…  │              │                  │
├───────────────┼────────────────────────────┼──────────────┼──────────────────┤
│ Subtitles     │ WhisperX · Classic style   │ Ready        │ [Regenerate]     │
│               │ Project default · Change…  │ 1 version    │                  │
├───────────────┴────────────────────────────┴──────────────┴──────────────────┤
│ Scene actions · Delete this scene and its scene-only media.  [Delete scene] │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Header

The header includes:

- Scene number and title.
- Aggregate status in words and numbers.
- Previous/next scene controls so users can audit several scenes without closing the modal.
- Close button.

The four columns remain recognizable across every generated row:

1. Entity and current output preview.
2. Resolved source/configuration and its scope.
3. Status and reason.
4. Always-visible primary action.

An optional later enhancement can add **Update all (n)**. It should only include missing or outdated dependencies that can run in valid pipeline order, show an estimated credit cost, and require the normal generation confirmation. It should not be part of the initial release unless the existing batch runner can safely express the dependency chain.

## Row design

The row itself is the controller. Every generated entity row uses the same left-to-right anatomy:

1. **Entity** — sequence, entity name, and a compact current output preview.
2. **Source/config** — resolved provider and model plus the few settings that materially identify how this entity is generated.
3. **Status** — Ready, Needs update, Not created, Generating, or Failed, with a concise reason where needed.
4. **Primary action** — Generate, Regenerate, Update, or Retry, always visible.

Recommended action labels:

| State | Primary action | Supporting copy |
|---|---|---|
| Not created | Generate | State the missing prerequisite if generation is unavailable. |
| Ready | Regenerate | Preserve the current version until generation succeeds. |
| Needs update | Update | Explain exactly which input changed. |
| Failed | Retry | Show the useful error message and failed-at time. |
| Generating | Generating… | Show progress when available; disable conflicting actions only. |

Generate and Regenerate are not hidden behind hover, a kebab menu, or row expansion. Activating the primary action operates on this entity in this scene. It may still use the application's normal cost/provider confirmation when required, but it should not first send the user through another entity-detail modal.

Rows should not change height when their status changes. Status belongs in a fixed column on desktop and directly below source/config on mobile. Primary actions use a consistent width to reduce visual jitter.

Expansion is optional and secondary. It exists for a larger editor or preview, version history, technical error details, references, recording, or keyframes. The user must not need to expand a row to discover how it was generated, change its scene-level configuration, or run its primary action.

### Source/config column

Show the settings that best explain the current or next output, not every available advanced option:

- Physical action, visual prompt, and narration: provider and model.
- Image: provider, model, aspect ratio, and resolution when applicable.
- Audio: provider, voice, language, and relevant quality mode.
- Video: provider, model, resolution, duration, aspect ratio, and keyframe mode.
- Subtitles: alignment provider/model, language, and subtitle style when relevant.

When an entity has no output, the column shows the **resolved next-run configuration**. When output exists and its recorded configuration matches the next-run configuration, show one compact description. When they differ, show both:

> Made with: ElevenLabs · Ava  
> Next run: OpenAI · Cedar · Scene override

This distinction explains where the visible output came from without misleading the user about what Regenerate or Update will do next.

Every next-run configuration has an explicit scope label:

- `Project default`
- `Scene override`

It also always exposes **Change…**. Change opens a compact inline panel or anchored popover for this row only. Its heading must name both scope and target, for example:

> Image settings · Scene 4 only

Saving uses an explicit label such as **Apply to this scene**. It creates or updates an entity-specific override on this scene; it never silently changes project defaults.

The same panel provides predictable secondary actions:

- **Use project default** — clears the scene/entity override and immediately displays the resolved project values.
- **Edit project defaults** — navigates to the relevant section of global Settings, clearly labeled as applying project-wide.

Do not ask the user to choose “this scene or all scenes?” on every change. Scope is determined by where the action was invoked: **Change…** is local, while **Edit project defaults** is global.

Changing configuration does not automatically spend credits or replace output. If output already exists, the row becomes **Needs update** and the primary action becomes **Update**.

### Expanded text rows

Physical action, visual prompt, and narration expose:

- Editable textarea.
- Explicit **Save changes** and **Discard** controls.
- Optional regeneration instruction.
- Generation time, version count, and fuller provenance beyond the key configuration already visible in the collapsed row.
- Version history with active-version selection.

Explicit save is preferable to changing dependency state on every keystroke. Closing the modal with an unsaved edit should prompt the user to save or discard.

### Expanded media rows

Image, audio, video, and subtitles expose:

- Large preview/player.
- Active version selector and complete version history.
- Generation time and complete provenance beyond the key configuration already visible in the collapsed row.
- The inputs used to make the selected version, summarized in plain language.
- Existing entity-specific controls, such as image Library and References, audio Record, and video keyframes.

Entity-specific tools live in the expanded area, but their placement and button order remain consistent.

### Source script row

The source row appears first and is visually distinct from generated entities.

- Label: **Source script**
- Status: **Source**, not Ready.
- Show the exact `sourceScriptFragment` when available, falling back to `scriptFragment`.
- Default to read-only to preserve its role as the original input.
- Provide **View in script** and **Copy** actions.
- If source editing is later supported here, it must explicitly warn that changing it can make action, narration, prompt, and downstream media need updates.

## Status language and semantics

Do not expose “stale” as the primary label. Use **Needs update**.

### Ready

The entity exists and its recorded generation inputs still match the current scene inputs and settings.

Example:

> Ready · Generated 8 minutes ago

### Needs update

The entity still exists and remains usable, but one or more inputs used to create it have changed. It is not broken and should not disappear.

Always pair the status with a reason:

- `Physical action changed after this prompt was generated.`
- `Visual prompt or image settings changed after this image was generated.`
- `Narration or voice changed after this audio was generated.`
- `The selected image or video settings changed after this video was generated.`
- `The active audio changed after these subtitles were generated.`
- `A neighboring scene changed, so this continuity-aware prompt may no longer match.`

For multiple causes, show the most actionable reason in the collapsed row and list all causes when expanded.

The **Update** action creates a new version. It never destroys the existing one, and a failed update leaves the old version selected and usable.

### Not created

No usable value or version exists and there is no newer failed attempt.

If prerequisites are missing, keep the row visible and explain the next step:

> Image prompt required before generating an image.

The action can either focus the prerequisite row or read `Create prompt first`.

### Failed

The newest attempt failed and no later attempt succeeded. Preserve any older successful version and distinguish:

- `Retry` when there is no usable version.
- `Retry update` when an older usable version remains.

Show a concise error in the row and technical details only in an expandable disclosure.

### Generating

Show the entity as generating without disabling unrelated rows. If the application currently serializes all operations, other generate controls can be disabled with the explanation `Available when the current generation finishes`.

## Dependency model

The interface should derive both status and reason from one centralized status model rather than reimplementing rules in the card and modal.

```text
Source script ──► Physical action ──┐
      └────────► Narration ─────────┼──► Visual prompt ──► Image ──► Video
                                   │                      │
                                   └──────────────────────┘

Narration + voice settings ──► Audio ──► Subtitles
```

Actual image and video manifests also include style, references, provider, model, output settings, and selected keyframes. The row reason should name the changed input rather than merely saying that a hash differs.

The existing implementation already detects outdated prompt, image, audio, video, and subtitle output. It does not currently present a stale state for narration, and the physical action lacks a first-class card status. Supporting precise status for every row will require persisted provenance for generated physical action and narration, plus consistent version history for generated text.

## Configuration scope and provenance

Each row needs two related but distinct records:

1. **Next-run configuration** — resolved from the scene/entity override when present, otherwise from project defaults.
2. **Version provenance** — the immutable provider, model, settings, source inputs, and other relevant values actually used to create a particular output version.

The resolution rule is simple:

```text
scene entity override ?? project default
```

The UI should never infer output provenance from current Settings. A project default may have changed since an output was created. That change is exactly what should produce a **Needs update** state and the `Made with` / `Next run` comparison.

Overrides should be stored per scene and per entity so changing video duration cannot accidentally override image resolution or another scene's provider. Clearing an override with **Use project default** removes the override rather than copying the current project value into it.

Global Settings remains the only place that changes defaults for the whole project. **Edit project defaults** should deep-link to the relevant settings group and, after returning, refresh the resolved configuration and status of affected rows.

## Version behavior

Consistency across prompts and media requires a common conceptual version model:

- Every successful generation creates an immutable version.
- A manual edit creates a version marked **Edited manually**.
- One version is active.
- Regeneration does not replace or delete the active version until the new version succeeds.
- Selecting an older version may cause downstream rows to need updates.
- Version entries show origin, provider/model when relevant, timestamp, and the input summary.

The UI can use different renderers for text, image, audio, video, and subtitles, but status, ordering, selection behavior, and action placement should match.

If text version persistence cannot ship in the first implementation slice, the UI should still use the same row shell but omit the version count for text. It should not imply that unavailable history exists.

## Delete scene

Delete is the final row in a separate **Scene actions** section, not a peer status in the generation pipeline.

- Use the full label **Delete scene** rather than a trash icon alone.
- Explain that the scene and scene-only generated media will be removed.
- Require a confirmation that names the scene number/title.
- Prefer a soft-delete or short-lived Undo notification if the storage model supports recovery.
- Disable deletion while generation for that scene is committing output.

This separation reduces accidental deletion while still keeping the action in the single scene-management destination.

## Accessibility and interaction requirements

- Do not rely on color to communicate any status.
- Pair every status with visible text and a distinct icon.
- The modal has an accessible name derived from the scene number and title.
- Rows are keyboard reachable in pipeline order.
- Expand controls expose `aria-expanded` and reference their panels.
- Generation changes are announced through a polite live region; failures use an assertive announcement.
- Focus returns to the Manage scene button that opened the modal.
- Previous/next navigation moves focus to the new modal heading.
- Escape closes the modal unless there is an unsaved edit or a destructive confirmation.
- Touch targets are at least 40 × 40 px.

## Responsive behavior

- **Desktop:** entity name/content, status, and action appear in aligned columns.
- **Tablet:** entity and source/config remain grouped; status and the visible primary action occupy a compact right column.
- **Mobile:** full-height sheet; each row retains the learned order of entity, source/config, status, and primary action; primary actions stretch to a consistent width; header navigation remains sticky.

Media previews should use a restrained collapsed thumbnail so seven rows remain scannable. Full media is shown only when expanded.

## Recommended implementation sequence

### Slice 1 — Unified entry and read-only overview

- Replace the icon strip and delete icon with the Manage scene summary button.
- Add the new modal shell and all rows.
- Reuse current generation functions and current entity detail controls.
- Surface source script and physical action.
- Centralize current presence, loading, failure, and outdated calculations.
- Keep each row's primary generation action visible and operable.
- Show the currently available provider/model/voice/media provenance.
- Move deletion into the modal.

This slice provides the primary cognition and control benefit without first requiring complete override persistence.

### Slice 2 — Consistent inline control

- Add per-scene, per-entity overrides with Change…, Use project default, and Edit project defaults.
- Show `Made with` and `Next run` when provenance and resolved configuration differ.
- Add row expansion and move current editors, previews, history, Library, References, Record, and keyframe controls into it.
- Add explicit save/discard for editable text.
- Add previous/next scene navigation.
- Generate plain-language reasons for every outdated state.

### Slice 3 — Complete text provenance and versions

- Persist versions and generation inputs for physical action, visual prompt, and narration.
- Add outdated detection for generated action and narration.
- Present one version-history pattern across text and media.

### Slice 4 — Optional scene-level orchestration

- Add Update all only after cost estimation, dependency ordering, cancellation, and partial-failure behavior are defined.

## Validation criteria

The design is successful when:

- A user can identify a scene with missing, outdated, or failed work from its single card button.
- A user can explain why an entity needs updating without knowing the term “stale.”
- Every entity can be generated or regenerated from one modal.
- Every row exposes its primary generation action without hover, expansion, or a second detail modal.
- A user can distinguish the settings used by the current output from those that will be used on the next run.
- Change… affects only the named entity in the open scene, while project-wide defaults remain clearly owned by global Settings.
- Existing successful output remains available during and after a failed update.
- A user can move through multiple scenes without repeatedly opening and closing entity-specific modals.
- Delete cannot be mistaken for a generation status or triggered without a named confirmation.
- Status remains understandable in grayscale and to a screen reader.

Useful usability-test tasks:

1. “Find the scene whose audio no longer matches its narration.”
2. “Regenerate only the visual prompt for scene 4.”
3. “Check which image version is active, then return to the overview.”
4. “Explain why the subtitles need an update.”
5. “Delete scene 4 without accidentally generating anything.”
6. “Change only scene 4's video duration, then return it to the project default.”
7. “Find the provider and voice that made the current audio, then identify what the next update will use.”

## Open product decisions

1. Should manually edited physical action and narration ever become **Needs update** relative to the source script, or should manual edits be treated as intentional and therefore current?
2. Should **Update all** include missing entities, outdated entities, or both?
3. Should users be able to edit the source fragment inside this modal, or only jump to the script editor?
4. Should selecting an older version automatically switch the active scene media, or require an explicit **Use this version** action?
5. Is soft-delete/Undo feasible with the current scene and asset-retirement model?

Recommended defaults: manual edits are current but make downstream output need updates; Update all is deferred; source remains read-only; old versions require **Use this version**; deletion uses Undo if technically feasible and named confirmation otherwise.
