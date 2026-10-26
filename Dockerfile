# syntax=docker/dockerfile:1

# Pinned base image (Node 26 on Alpine). Dependabot keeps this current.
ARG NODE_IMAGE=node:26.12.1-alpine3.24

# ---------------------------------------------------------------------------
# Stage 1 — build the Vite frontend bundle
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Install ALL dependencies (incl. devDeps: vite, three) reproducibly from the
# lockfile. --ignore-scripts: no dependency gets to run code at install time.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# Copy only what the build needs (index.html at project root + src/).
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only (express, helmet, rate limiter)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 3 — minimal runtime image
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="usdz-viewer" \
      org.opencontainers.image.description="Lightweight web viewer for USD/USDA/USDC/USDZ with WebXR AR" \
      org.opencontainers.image.source="https://github.com/canerkoroglu/usdz-viewer"

ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/app/data

# Pick up Alpine security fixes released after the base image was built, and
# remove package managers the runtime never needs (smaller attack surface,
# fewer scanner findings).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

WORKDIR /app

# Application files stay owned by root and read-only for the runtime user; the
# app never writes to disk. Only the (bind-mounted) data dir belongs to `node`.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 8090
# The image's unprivileged `node` user, by numeric id so orchestrators can
# verify runAsNonRoot without resolving names.
USER 1000:1000

# Container-level healthcheck (compose also defines one). Uses Node's built-in
# fetch — no curl/wget dependency required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
