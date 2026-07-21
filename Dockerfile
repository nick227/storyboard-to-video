# TEMPORARY monorepo-root build for Railway while Root Directory is unset.
# This week: set service Root Directory to apps/web in the Railway dashboard, then
# delete this file and root railway.toml so apps/web/Dockerfile is the only image def.
# Editing apps/web/Dockerfile alone does nothing until that switch happens.
#
# Context is the repo root; app sources live under apps/web/.

FROM node:20-slim AS build

WORKDIR /app

COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

COPY apps/web/ ./
RUN npm run prisma:build
RUN npm prune --omit=dev

FROM node:20-slim

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start:production"]
