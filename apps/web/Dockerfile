FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run prisma:build
RUN npm prune --omit=dev

FROM node:20-slim

# Prisma engines on Debian slim need OpenSSL at runtime (migrate + client).
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
EXPOSE 3000

# Prefer Railway preDeployCommand for migrations (see railway.toml). This CMD is
# the fallback when that is unset: migrate then serve. Persist runtime media by
# mounting a Railway Volume at /app/data (matches config.paths under data/).
CMD ["npm", "run", "start:production"]
