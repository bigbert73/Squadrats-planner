# Stage 1: build — apt is more reliable than Alpine apk in corporate/OCP environments
FROM node:20 AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src

# Stage 2: lean runtime (glibc-compatible with builder, so native .node works)
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package*.json ./
# Support arbitrary UIDs (OpenShift assigns random non-root UIDs)
RUN mkdir -p /app/data \
    && chgrp -R 0 /app \
    && chmod -R g=u /app
EXPOSE 3000
CMD ["node", "src/index.js"]
