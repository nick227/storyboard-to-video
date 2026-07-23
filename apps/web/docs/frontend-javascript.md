# Frontend JavaScript architecture

Browser JavaScript is served from `public/js/`.

## Current ownership

- `app.js` is the authenticated studio entry point.
- `billing/` contains credit balances, provider-price formatting, and token-spend presentation.
- `core/` contains API, authentication, state, persistence, DOM contracts, and scene primitives.
- `generation/` contains batch execution, manifests, reference planning, stage orchestration, and generation workflows.
- `media/` contains voice handling, scene recording, media settings, and subtitle overlays.
- `pages/` contains one entry point per standalone HTML page.
- `shared/` contains browser components used by multiple independent pages.
- `scripts/` owns public-script APIs/chrome plus studio editing, exporting, and publishing.
- `screenplay-editor/` is the self-contained portable editor package.
- `studio/` contains rendering, timeline, UI composition, and feature controllers for the authenticated studio.
- `tests/` contains the browser test harness.

Page entry points may import domain modules, but domain modules must not import
from `pages/`. Keep domain dependencies directed toward shared foundations and
run the full frontend syntax and import checks after moving browser code.
