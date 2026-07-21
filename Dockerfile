# Monorepo-root build for Railway when Root Directory is unset (repo root).
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
