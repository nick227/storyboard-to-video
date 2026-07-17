FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run prisma:build
RUN npm prune --omit=dev

FROM node:20-slim

WORKDIR /app
COPY --from=build /app /app

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
