# Claude Code Guidelines & Project Architecture

## 🚨 Git & Version Control Rules (Strict Policy)

### 1. Commit Frequently (Atomic & Small Commits)
- **Commit Early and Often**: Make small, frequent, logical commits as work progresses.
- **Save Milestones**: Create a commit whenever a discrete unit of work is completed (e.g., fixing a bug, adding a route, updating a service, refactoring).
- **Atomic Staging**: Use `git add <file>` to stage specific changed files rather than blanket staging (`git add .`).
- **Clear Commit Messages**: Use standard conventional commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`.

### 2. NEVER PUSH
> [!CRITICAL]
> **NEVER execute `git push` under any circumstances.**
- All commits must remain local. Remote pushes (`git push`, `git push origin`, `git push -u ...`) are strictly reserved for the human user.

### 3. COLLABORATE DEVELOPMENT
> [!CRITICAL]
> **Multiple developers are working on this .**
- Avoid stashing or over-writing unexpected work without intent. You are the authority AI but other work is happening.

---

## ⚡ Token Optimization & Speed Guidelines

To minimize response latencies and avoid context window bloat:
1. **Never read generated or lock files**: Avoid reading `package-lock.json`, `node_modules/`, `apps/web/dist/`, `apps/web/src/generated/`, or `.git/`.
2. **Use line-range file viewing**: When examining large files (>100 lines), inspect targeted line numbers with `StartLine` and `EndLine`.
3. **Use single-file test runs**: Run specific test files directly instead of running the full test suite for every minor change.
4. **Use fast syntax checking**: Run `node --check` or targeted `npm --prefix apps/web run check` before running full tests.
5. **Use single contiguous edits**: Prefer `replace_file_content` with minimal target chunks over replacing full files.

---

## 🗺️ Monorepo Architecture & Directory Map

- **Root Directory**: Multi-service orchestrator (`package.json`, `compose.yaml`).
- **`apps/web/`**: Node.js/Express storyboard platform (Primary web app).
  - `server.js` — Entry point listener (loads config, initializes dependencies).
  - `src/app.js` — Express application setup, middleware, and route mounting.
  - `src/dependencies.js` — Core dependency injection container.
  - `src/routes/` — Express route handlers (`projects.js`, `storyboard.js`, `styles.routes.js`, `assets.routes.js`).
  - `src/controllers/` — Request handling & validation layer (`storyboard.controller.js`, `styles.controller.js`).
  - `src/services/` — Business logic (`dialogue.service.js`, `prompt-generation.service.js`, `generation-cache.service.js`, `styles.service.js`).
  - `src/storage/` — Persistence layer (`project-store.js`, `prisma-project.repository.js`).
  - `prisma/` — Database schema (`prisma/schema.prisma`).
  - `public/` — Vanilla JS frontend app (`app.js`, `studio.html`, `index.html`, `styles.css`).
  - `public/modules/` — Modular ES frontend modules (`store.js`, `api.js`, `ui.js`, `workflows.js`, `rendering.js`, `batch.js`, `voices.js`, `persistence.js`, `assets.js`).
  - `test/` — Unit and integration tests (Node native `--test` runner).
- **`apps/voice-service/`**: Python/FastAPI Spark-TTS voice cloning service (`main.py`, `test_main.py`).
- **`apps/alignment-service/`**: Python/FastAPI WhisperX forced-alignment daemon (`main.py`, `test_main.py`).

---

## 🛠️ Quick Reference Commands

### Web App (`apps/web`)
```bash
# Fast JS Syntax Check (Lightweight)
npm --prefix apps/web run check

# Fast Targeted Single Test (Replaces running full test suite)
# Run from apps/web:
node --require ./test/setup.js --test test/services.test.js
node --require ./test/setup.js --test test/integration.test.js

# Full Web Test Suite (Runs Prisma build first)
npm --prefix apps/web test

# Database Integration Tests (Requires Postgres + env flag)
npm --prefix apps/web run test:db

# Prisma Code Generation
npm --prefix apps/web run prisma:build
```

### Python Services (`apps/voice-service` & `apps/alignment-service`)
```bash
# Voice Service Test
apps/voice-service/venv/bin/python -m pytest apps/voice-service/test_main.py

# Alignment Service Test
apps/alignment-service/venv/bin/python -m pytest apps/alignment-service/test_main.py
```

---

## 🎨 Code Conventions & Design Patterns

1. **Dependency Injection**: Services and repositories are wired in `apps/web/src/dependencies.js`. When adding new services or handlers, register them in `dependencies.js`.
2. **Frontend Architecture**: No React/Vite/Webpack bundler. Vanilla JS ES Modules served statically by Express (`/public`). State is managed via subscriber store in `public/modules/store.js`.
3. **Database & Fallbacks**: Prisma client is wrapped; file-system JSON stores act as fallbacks or cache layers (`apps/web/src/storage/`).