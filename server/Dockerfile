# syntax=docker/dockerfile:1
# ============================================================================
# server/Dockerfile — arm64 image for the Secret Hitler authoritative server.
#
# Multi-stage: install production-only deps in one cached layer, then copy them
# plus the source into a slim runtime that runs as the non-root `node` user.
#
# BUILD CONTEXT IS THE REPO ROOT (not server/), because the server imports the
# shared rules engine from js/. The CI builds with:
#     docker build -f server/Dockerfile .
# ============================================================================

# --- deps -------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Manifests only, so this layer stays cached until the deps change. `ci` installs
# the exact tree in package-lock.json, so an image built today and one built in six
# months contain the same `ws` — `install` would silently drift to a new minor.
# --omit=dev keeps it to just `ws`.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- runtime ----------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Stamped by CI (defaults to "dev" for local builds); surfaced at /health.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules ./node_modules

# The manifest is what marks this tree "type":"module" — without it Node would
# parse js/engine.js as CommonJS and the server's import would fail outright.
COPY package.json ./
COPY server ./server
COPY js ./js

USER node

EXPOSE 9000

# Liveness on the same endpoint the browser probes. Alpine has no curl, and
# `require` works inside `node -e` even though the tree is ESM.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:9000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
