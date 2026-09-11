# usdz-viewer

A lightweight, self-hosted web viewer for **USD / USDA / USDC / USDZ** 3D assets with
**WebXR passthrough AR** (Meta Quest). One Express server, one Vite/three.js frontend,
no database, no accounts.

- Drop model files in `./data` — they are served **read-only**, never copied or modified.
- Desktop: orbit / zoom / pan, animation playback, full viewer-side lighting, shadows,
  environment and transform controls, model statistics.
- Quest: **Start AR** → passthrough → aim the reticle at a surface → trigger/pinch to place →
  scale / rotate / play-pause / reset. Placement is true real-world scale (USD units are applied).
- Model gallery with preview thumbnails, sorting, format filters and search.
- Share any model as a link or QR code (`/?model=chair.usdz`).

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

The container runs as a non-root user, restarts unless stopped, and exposes a healthcheck on
`GET /api/health`.

## HTTP API

| Route | Purpose |
|---|---|
| `GET /api/health` | `{"status":"ok","service":"usdz-viewer"}` |
| `GET /api/models` | Metadata for every supported file in `./data` (name, extension, size, url). Sorted, Unicode-safe, never cached. |
| `GET /models/<name>?v=<mtime>` | Streams one model (range requests supported, 1 h cache; the `v` query changes when the file changes). Strict path-traversal protection — only files directly inside `./data` with an allowed extension are served. |

## Running behind Nginx Proxy Manager (HTTPS)

WebXR only works in a **secure context**, so for the Quest you need HTTPS (or `localhost`, see below).

1. NPM → **Proxy Hosts → Add**: domain `3d.example.com`, scheme `http`, forward host = your Docker host IP, **forward port `8090`**. Enable *Block Common Exploits* and *Websockets Support*.
2. **SSL** tab: request a Let's Encrypt certificate, enable *Force SSL* and *HTTP/2*.
3. Open `https://3d.example.com` on the Quest — or press **Share** on the desktop and scan the QR code.

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
| Play / pause animation | **Space**, the transport bar at the bottom (scrub, clip, speed), or the ▶/⏸ button in AR |
| Pick a model | **▤ Models** gallery — grid or list, sort by name / size / date / type, format filters, accent-insensitive search (`kucuk` finds *Küçük*), arrow keys move between cards |
| Preview thumbnails | Captured automatically the first time a model is viewed and cached in the browser (IndexedDB, refreshed when the file changes). **Generate previews** runs a one-off pass over models that have none — nothing is preloaded otherwise |
| Open a specific model | `/?model=<filename>` — the URL updates as you switch models |
| Share | **Share** button → link + QR code |
| Preview a local file | Drag & drop a USD file onto the viewer (parsed in the browser, never uploaded) |
| Close dialogs | **Esc** |

All settings (lighting presets, lights, shadows, environment, ground, transform, quality, AR lighting)
persist in `localStorage`; **Reset all** restores the Quest-friendly defaults. The *Model info* section
shows dimensions (m / cm), mesh, triangle, material, texture and animation counts for the loaded file.

## Development & tests

```bash
npm ci
npm run dev                          # Vite dev server (frontend)
DATA_DIR=./data node server.js       # API on http://localhost:8090
npm test                             # server tests (Node's built-in runner, no extra deps)
npm run build                        # production bundle -> dist/
```

CI (`.github/workflows/ci.yml`) runs the build, the test-suite and a Docker image build on every
push and pull request.

## Project layout

```
Dockerfile              multi-stage build (node:24-alpine), non-root runtime
docker-compose.yml      service, read-only data mount, healthcheck
server.js               Express 5 — API + traversal-safe streaming (createApp() factory)
test/server.test.js     HTTP + path-safety tests
index.html              Vite entry (must stay at the project root)
src/main.js             three.js viewer, settings UI, animation, WebXR AR
src/style.css           dark, responsive UI (sidebar on desktop, bottom sheet on phones)
vite.config.js          build config
```

## Known limitations

- USD **material variants** load with the file's default variant (switching variants is not exposed yet).
- WebXR **light estimation** is used when the browser exposes it; otherwise the *AR lighting* mode is a manual fallback.
- Some USDC (binary crate) array types are skipped by three.js's parser with a console warning; such attributes are simply ignored.
- The viewer never writes to your model files. All lighting, shadow, ground, transform and animation state is viewer-side only.
