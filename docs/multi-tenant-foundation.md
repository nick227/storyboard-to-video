# Multi-tenant foundation

## Ownership invariant

Authentication identifies a user. Authorization is scoped to a workspace (`tenantId`). Every new user receives a personal workspace and an owner membership. Project documents, generated assets, and generation jobs carry the tenant scope; `createdByUserId` records attribution separately.

Platform styles, starter references, and platform voices remain shared catalog resources. Custom prompt profiles, cloned voices, and uploaded references will be tenant-owned in the next slice.

## Authentication

- Local development and production require `DATABASE_URL` and use Prisma/PostgreSQL for users, workspaces, memberships, and sessions.
- Prisma migrations are the database authority; application startup never creates tables.
- Passwords use Argon2id.
- Browser sessions use random opaque tokens. Only SHA-256 token hashes are persisted.
- The browser receives the token in an `HttpOnly`, `SameSite=Strict` cookie and never stores credentials in `localStorage`.
- `AUTH_TOKENS` remains a local/test compatibility adapter while existing automation migrates.

Prisma is isolated behind repository interfaces. The Prisma 7 client is generated as CommonJS-compatible TypeScript and compiled into `dist/generated/prisma`; the rest of the Node application remains CommonJS during this foundation. Controllers and services must not import Prisma directly.

## Storage transition

Project documents still use the filesystem store in this slice. The store lazily migrates legacy `ownerId` documents to `tenantId` and `createdByUserId`. The next persistence slice will move project/job/asset metadata into PostgreSQL while media bytes remain on the filesystem volume.

## HTTP surface

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/session`
- `POST /api/auth/logout`

All other `/api`, `/projects`, and `/style-references` routes require an authenticated tenant context.

## Remaining Phase 1 work

1. Add email verification, password reset, and distributed rate limiting.
2. Migrate project, job, idempotency, tombstone, and asset metadata to PostgreSQL.
3. Add a one-shot legacy-project ownership importer.
4. Replace filesystem media addressing with an object-store adapter and tenant-prefixed keys.
5. Add per-tenant queue concurrency and storage quotas.
6. Remove the `AUTH_TOKENS` compatibility path after automation uses sessions.
