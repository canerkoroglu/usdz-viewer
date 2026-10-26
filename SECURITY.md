# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability**
(Security → Advisories) on this repository rather than in a public issue. Include steps to
reproduce and the affected version or commit.

## Threat model

usdz-viewer is a self-hosted, read-only viewer. It has no accounts, no uploads and no write
endpoints. The assets worth protecting are:

- the **host filesystem** outside the model directory,
- the **container** (its code and environment),
- **viewers' browsers**, which parse untrusted 3D files,
- **availability** of the service.

Model files are treated as untrusted input: anyone who can place a file in `./data`, or who
convinces a user to drag one onto the viewer, controls its contents.

## Controls

### Server (`server.js`)

| Risk | Control |
|---|---|
| Path traversal / arbitrary file read | Model names must be a single path component with an allowed extension (no `..`, slashes, backslashes, NUL, dotfiles, >255 chars). The real path (after symlinks) must stay inside the data directory, so `x.usdz -> /etc/passwd` is a 404. |
| Content sniffing / script in model files | `X-Content-Type-Options: nosniff`, explicit non-HTML MIME types, and `Content-Security-Policy: default-src 'none'; sandbox` on every model response. |
| XSS in the app | Strict CSP: `script-src 'self'`, `style-src 'self'`, no `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, `base-uri 'none'`. The frontend builds DOM with `textContent`, never with untrusted HTML. |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY`. |
| Cross-origin leaks | `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`. |
| Unneeded browser features | `Permissions-Policy` allows WebXR for this origin only and disables camera, microphone, geolocation, payment, USB, serial, Bluetooth and HID. |
| Information disclosure | No `X-Powered-By`; API errors are generic JSON; no host paths or stack traces in responses; unknown routes return a plain 404 that does not reflect the URL. |
| Denial of service | Per-IP rate limit on `/api` and `/models` (`RATE_LIMIT_PER_MINUTE`); catalogue capped at 5000 entries; header/request timeouts against slow clients; files are streamed, never buffered. |
| IP spoofing via `X-Forwarded-For` | `trust proxy` is off by default and must be set explicitly (`TRUST_PROXY`) to the reverse proxy's address. |
| Invalid configuration | Environment variables are validated at startup; the server refuses to start on bad values. |

HSTS is intentionally **not** sent by the app: set it on the TLS-terminating reverse proxy
(e.g. Nginx Proxy Manager → *SSL → HSTS Enabled*).

### Browser (`src/`)

- USDZ archives are checked from the zip central directory **before** inflating: at most
  10 000 entries, 512 MiB per entry and 1.5 GiB in total; entries the viewer does not use are
  never decompressed. Local files above 1 GiB are refused.
- Settings, gallery and playback state read from `localStorage` are untrusted: only known keys of
  the expected type are accepted (`mergeKnown`), and prototype-polluting keys are ignored.
- `/api/models` entries are validated and must point at same-origin `/models/...` URLs.
- The `window.__viewer` debug hook exists only in development or with `?debug` in the URL.

### Container and supply chain

- Pinned base image, multi-stage build, `npm ci --ignore-scripts` (no install-time code from
  dependencies), production dependencies only, npm/corepack removed from the runtime image,
  Alpine packages upgraded at build time.
- Runs as the unprivileged `node` user; application files are root-owned and read-only.
- Compose: read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, PID and memory limits,
  init process, rotated logs, model directory mounted read-only.
- CI: least-privilege `GITHUB_TOKEN`, all actions pinned to commit SHAs, `persist-credentials:
  false`, `npm audit` gate, dependency review on pull requests, CodeQL (security-extended),
  image SBOM and SLSA provenance with a signed build attestation, Dependabot for npm, actions
  and the base image.

## Operator checklist

- Put the service behind HTTPS (required for WebXR anyway) and enable HSTS on the proxy.
- Set `TRUST_PROXY` to the proxy's address or subnet when using one.
- Keep `./data` writable only by people you trust — the viewer is hardened against hostile
  files, but it still renders whatever is there.
- Pull new images regularly (`docker compose pull && docker compose up -d`).
