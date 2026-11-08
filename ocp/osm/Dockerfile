# Rebuilds pois.db, popular.db and reach.db with tools/update-pois.sh.
# Build context must be the repo root (no contextDir in BuildConfig).
FROM node:20 AS builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev

FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY backend/package*.json ./
COPY backend/src ./src
COPY tools/update-pois.sh ./tools/update-pois.sh
