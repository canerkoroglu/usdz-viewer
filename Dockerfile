# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build the Vite frontend bundle
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

# Install ALL dependencies (incl. devDeps: vite, three) reproducibly.
COPY package.json package-lock.json ./
RUN npm ci

# Copy only what the build needs (index.html at project root + src/).
COPY index.html ./
COPY vite.config.js ./
COPY src ./src

# Produce /app/dist
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — minimal runtime image (Express only)
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8090 \
    DATA_DIR=/app/data

WORKDIR /app

# Install runtime dependencies only (omits vite; the browser bundle is already
# built, so three is not imported at runtime either).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App code + built assets
COPY server.js ./
COPY --from=build /app/dist ./dist

# Data directory is a bind-mount target at runtime; create it so the app can
# start even before anything is mounted, and hand ownership to the non-root
# user baked into the node image.
RUN mkdir -p /app/data && chown -R node:node /app

EXPOSE 8090

# Drop root.
USER node

# Container-level healthcheck (compose also defines one). Uses Node's built-in
# fetch — no curl/wget dependency required.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
