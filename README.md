# Storyboard Image POC

Gemini-first POC for turning story text into a storyboard with editable prompts, serial image generation, scene versions, and per-style reference images.

## What changed in this version
- Gemini is now the default text and image provider (`gemini-3.5-flash` and `gemini-3.1-flash-image` by default)
- Each style now has its own character reference images and world reference images
- Reference images can be uploaded, previewed, and deleted in the UI
- Gemini uses style references when generating prompts and images
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
- Reorder scenes
- Download selected scene images and a prompt-rich `storyboard.json` manifest as a ZIP
- Create and switch between autosaved storyboards in browser localStorage
- Validate and limit reference uploads to 8 images per category and 8 MB per image
- Warn when local fallback prompts are used because a text provider is unavailable

## Included styles
- Basic Cartoon
- Cinematic Reality
- Dark Gothic
- Indie Youtuber
- Vox Style

## Quick start
1. Copy `.env.example` to `.env`
2. Fill in at least `GEMINI_API_KEY` for the default setup
3. Install dependencies:
   ```bash
   npm install
   ```
4. (Optional) Install the local Piper voice engine for natural-sounding offline TTS:
   ```bash
   npm run setup:piper
   ```
5. Start the app:
   ```bash
   npm start
   ```
6. Open `http://localhost:3000`

## Local voices
- The audio provider dropdown includes two zero-API-key options: a rudimentary local voice (always available, no setup) and **Piper** (natural neural TTS, requires `npm run setup:piper` once — downloads a ~26 MB engine and a ~60 MB voice model into `vendor/piper/`, not committed to git).
- ElevenLabs remains available as a cloud option when `ELEVENLABS_API_KEY` is set.
- Each detected speaker is auto-assigned a voice for the local providers; no manual mapping is required unless you're using ElevenLabs.

## Reference image behavior
- Style references live under `style-references/<style-id>/characters` and `style-references/<style-id>/world`
- The app automatically loads the active style's references
- Gemini receives those references during prompt generation and image generation
- OpenAI and Dezgo remain available as optional alternates

## Storage
- Generated images are written under `data/generated`
- Zip exports are written under `data/zips`
- Storyboards are autosaved client-side in localStorage; use the title dropdown to reopen one

Generated files and ZIP exports are not automatically purged in this POC. Remove old files periodically in long-running deployments.

## POC stakes
1. Convert pasted narrative text into a controllable visual sequence.
2. Preserve selected style plus recurring character/world continuity through references.
3. Keep prompts and images independently editable while preserving version history.
4. Keep serial generation interruptible, resumable, and exportable.

## Intentionally stubbed
- Select `Stub Preview (no API)` to exercise the full image workflow without API keys.
- Stub previews are simple SVG storyboard cards, not generated art.
- Accounts, database persistence, cloud storage, billing, durable job queues, collaboration, and local generation are deferred.
