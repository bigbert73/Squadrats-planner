FROM node:20-alpine

# Build tools needed for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files first (layer caching)
COPY package*.json ./
RUN npm ci

# Copy source (in dev, this is overridden by volume mount)
COPY src ./src

EXPOSE 3000

# nodemon for hot-reload in dev
CMD ["node", "src/index.js"]
