# usdz-viewer

A lightweight, self-hosted web viewer for **USD / USDA / USDC / USDZ** 3D assets with
**WebXR passthrough AR** (Meta Quest). One Express server, one Vite/three.js frontend,
no database, no accounts.

- Drop model files in `./data` — they are served **read-only**, never copied or modified.
- Desktop: orbit / zoom / pan, animation playback, full viewer-side lighting, shadows,
  environment and transform controls, model statistics.
- Quest: **Start AR** → passthrough → aim + **trigger** to place → **controller thumbstick to scale (↕) and rotate (↔), A/X to reset, B/Y to exit**.
  Placement is true real-world scale (USD units are applied). The controllers drive everything because Quest's dom-overlay button taps are unreliable.
- Model gallery with preview thumbnails, sorting, format filters and search.
- Deep-link to any model — the URL reflects the current model (`/?model=chair.usdz`).

## Quick start

```bash
docker compose up -d --build
```

Open **http://localhost:8090**. Put `.usd` / `.usda` / `.usdc` / `.usdz` files in `./data`
and press **Refresh** in the Models dialog (or drag & drop a local file onto the viewer to preview
it without copying it anywhere).

```
./data        ← your models (bind-mounted read-only at /app/data)
docker compose logs -f usdz-viewer
docker compose down
```

The container runs as a non-root user with a read-only root filesystem, no Linux capabilities
and `no-new-privileges`, restarts unless stopped, and exposes a healthcheck on `GET /api/health`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | Listen port (validated, 1–65535) |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `/app/data` | Directory with the model files (read-only mount) |
| `TRUST_PROXY` | *(off)* | Trust `X-Forwarded-*` from these proxies: a hop count (`1`), or addresses/subnets/presets (`loopback, 172.16.0.0/12`). Needed behind a reverse proxy so rate limiting sees real client IPs. Avoid `true`. |
| `RATE_LIMIT_PER_MINUTE` | `600` | Requests per minute per client IP on `/api` and `/models` (`0` disables). The health probe is never limited. |

Invalid values stop the server at startup with a clear message.

## HTTP API

| Route | Purpose |
|---|---|
| `GET /api/health` | `{"status":"ok","service":"usdz-viewer"}` |
| `GET /api/models` | Metadata for every supported file in `./data` (name, extension, size, url). Sorted, Unicode-safe, never cached. |
| `GET /models/<name>?v=<mtime>` | Streams one model (range requests supported, 1 h cache; the `v` query changes when the file changes). Strict path-traversal protection — only files directly inside `./data` with an allowed extension are served; symlinks are followed only while they stay inside `./data`. |

Errors are JSON (`{"error": "..."}`) on `/api` and `/models`; no paths or stack traces are ever
returned. See [SECURITY.md](SECURITY.md) for the full security model.

## Deploying the prebuilt image (e.g. the Windows Docker host)

CI publishes `ghcr.io/canerkoroglu/usdz-viewer:latest` (plus a short-SHA tag) on every push to
`main`. On the host you can then skip building entirely:

```bash
docker compose pull
docker compose up -d
```

The compose file keeps its `build:` block, so `docker compose up -d --build` still builds locally.
GitHub creates the package as **private** on first publish: either make it public in the package's
settings on GitHub, or `docker login ghcr.io` on the host with a token that has `read:packages`.

## Running behind Nginx Proxy Manager (HTTPS)

WebXR only works in a **secure context**, so for the Quest you need HTTPS (or `localhost`, see below).

1. NPM → **Proxy Hosts → Add**: domain `3d.example.com`, scheme `http`, forward host = your Docker host IP, **forward port `8090`**. Enable *Block Common Exploits* and *Websockets Support*.
2. **SSL** tab: request a Let's Encrypt certificate, enable *Force SSL* and *HTTP/2*.
3. Open `https://3d.example.com` on the Quest.

The frontend uses only relative URLs, so nothing else needs configuring.

### Testing on a Quest without a domain

Connect the headset over USB with developer mode on, then:

```bash
adb reverse tcp:8090 tcp:8090
```

Open **http://localhost:8090** in the Quest Browser — `localhost` counts as a secure context, so AR works.

## Controls

| Action | How |
|---|---|
| Orbit / zoom / pan | Drag / scroll / right-drag (two-finger on touch) |
| Fit camera to model | **F** key, double-click the viewer, or *Model transform → Fit camera* |
| Switch material variants | *Variants* section in the sidebar (appears when the file defines variant sets) — re-composes in place, no re-download; MaterialX-driven variants are baked to textures. Animation-type variant sets switch the playing clip instantly (no re-parse) and stay in sync with the transport clip picker. |
| Play / pause animation | **Space**, the transport bar at the bottom (scrub · clip · speed · loop: repeat / once / ping-pong), or the ▶/⏸ button in AR. Speed and loop mode persist across reloads. |
| Pick a model | **▤ Models** gallery — grid or list, sort by name / size / date / type, format filters, accent-insensitive search (`kucuk` finds *Küçük*), arrow keys move between cards |
| Preview thumbnails | Captured automatically the first time a model is viewed and cached in the browser (IndexedDB, refreshed when the file changes). **Generate previews** runs a one-off pass over models that have none — nothing is preloaded otherwise |
| Open a specific model | `/?model=<filename>` — the URL updates as you switch models |
| Preview a local file | Drag & drop a USD file onto the viewer (parsed in the browser, never uploaded) |
| Close dialogs | **Esc** |

All settings (lighting presets, lights, shadows, environment, ground, transform, quality, AR lighting)
persist in `localStorage`; **Reset all** restores the Quest-friendly defaults. The *Model info* section
shows dimensions (m / cm), mesh, triangle, material, texture and animation counts for the loaded file.

## Development & tests

```bash
npm ci
DATA_DIR=./data npm start            # API + built app on http://localhost:8090
npm run dev                          # Vite dev server on http://localhost:5173 (proxies /api, /models to :8090)
VITE_HOST=0.0.0.0 npm run dev        # ...deliberately exposed on the LAN
npm test                             # server + frontend unit tests (Node's built-in runner)
npm run lint                         # ESLint
npm run format                       # Prettier (format:check in CI)
npm run check                        # lint + format check + tests
npm run build                        # production bundle -> dist/
```

Requires Node.js 24 or newer (the Docker image and CI use Node 26).

CI (`.github/workflows/ci.yml`) runs on Node 24 and 26: `npm audit`, lint, the format check, the
test-suite and the build, then builds the Docker image (with SBOM and provenance; pushed and
attested on `main`). Pull requests also get a dependency review, CodeQL scans weekly and on every
change, and Dependabot keeps npm packages, GitHub Actions (SHA-pinned) and the base image current.

## Project layout

```
Dockerfile              multi-stage build (pinned node:26-alpine), non-root, no npm at runtime
docker-compose.yml      service, read-only data + root fs, dropped capabilities, healthcheck
server.js               Express 5 — API, traversal-safe streaming, CSP/headers, rate limits
SECURITY.md             threat model, controls and how to report issues
test/server.test.js     HTTP, path-safety, headers, symlink and rate-limit tests
test/utils.test.js      unit tests for the pure frontend helpers
test/usd.test.js        unit tests for USD parsing / variants / binding strength
index.html              Vite entry (must stay at the project root)
src/main.js             three.js scene, settings UI, animation, gallery, WebXR AR (app wiring)
src/config.js           defaults, presets, option tables, storage keys
src/usd.js              USD/USDA/USDC/USDZ parsing, variant enumeration, material-binding strength
src/mtlx.js             MaterialX graph baker (recolour variants, RealityKit approximations)
src/utils.js            pure helpers (formatting, matching, deep merge)
src/storage.js          safe localStorage JSON helpers
src/thumbstore.js       IndexedDB persistence for gallery previews
src/dom.js              tiny DOM helpers
src/style.css           dark, responsive UI (sidebar on desktop, bottom sheet on phones)
vite.config.js          build + dev-server config (dev proxy to the backend)
```

## Known limitations

- **MaterialX materials**: the viewer bakes common node graphs (image, HSV, mix, math…) to textures — that is how recolour variants render. RealityKit-only nodes (camera background blur, environment radiance, unlit surfaces) are approximated and flagged under *Variants*.
- WebXR **light estimation** is used when the browser exposes it; otherwise the *AR lighting* mode is a manual fallback.
- Some USDC (binary crate) array types are skipped by three.js's parser with a console warning; such attributes are simply ignored.
- The viewer never writes to your model files. All lighting, shadow, ground, transform and animation state is viewer-side only.
