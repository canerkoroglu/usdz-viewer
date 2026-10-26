/**
 * usdz-viewer — Express 5 backend
 *
 * Responsibilities:
 *   - Serve the built Vite frontend (dist/)
 *   - GET /api/health        -> liveness probe
 *   - GET /api/models        -> metadata for supported model files in the data dir
 *   - GET /models/:filename  -> stream a single model file (traversal-safe)
 *
 * The original model files are NEVER copied into the image; they live on the
 * host and are bind-mounted read-only at DATA_DIR (default /app/data).
 *
 * Security model (see SECURITY.md): the server is read-only, has no accounts
 * and no write endpoints. Every request is confined to two directories (dist/
 * and the data dir), responses carry a strict CSP and hardening headers, model
 * files are served as inert downloads, and API/model routes are rate limited.
 *
 * `createApp()` builds the Express app for a given configuration so the
 * test-suite can run instances against fixture folders; running this file
 * directly (`node server.js`) starts the real server.
 */

import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Supported model extensions (lowercase, without the dot).
export const ALLOWED_EXT = new Set(['usd', 'usda', 'usdc', 'usdz']);

// MIME types per extension. USDA is ASCII text; USDC is a binary crate; USD may
// be either, so we serve it as a safe binary stream; USDZ is a zip archive.
export const MIME_TYPES = {
  usd: 'model/vnd.usd',
  usda: 'text/plain; charset=utf-8',
  usdc: 'application/octet-stream',
  usdz: 'model/vnd.usdz+zip',
};

// Upper bound on catalogue entries, so a pathological data directory cannot
// turn one /api/models request into an unbounded amount of work.
export const MAX_MODELS = 5000;

// The viewer's Content-Security-Policy. Everything is same-origin; `data:` and
// `blob:` images cover generated thumbnails and textures unpacked from USDZ
// archives. No inline script or style, no plugins, no framing.
export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'none'"],
  objectSrc: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'blob:'],
  connectSrc: ["'self'", 'blob:', 'data:'],
  fontSrc: ["'self'"],
  mediaSrc: ["'none'"],
  workerSrc: ["'none'"],
  manifestSrc: ["'self'"],
};

// Model files are data, never documents: if one is opened directly in a tab it
// must not be able to run script or load anything.
const MODEL_CSP = "default-src 'none'; sandbox";

// Powerful browser features the app does not use are disabled outright;
// WebXR (immersive AR) is allowed for this origin only.
const PERMISSIONS_POLICY = ['xr-spatial-tracking=(self)', 'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'serial=()', 'bluetooth=()', 'hid=()'].join(', ');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Parse Express's `trust proxy` setting from an environment string.
 * Unset / "false" -> false (default: do not trust X-Forwarded-* at all),
 * "true" -> true, an integer -> hop count, anything else -> a comma-separated
 * list of addresses / subnets / presets ("loopback", "uniquelocal", ...).
 */
export function parseTrustProxy(value) {
  if (value == null || value.trim() === '' || value.trim().toLowerCase() === 'false') return false;
  const v = value.trim();
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntInRange(name, raw, fallback, min, max) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)} (expected an integer between ${min} and ${max})`);
  }
  return n;
}

/** Validated runtime configuration from environment variables. */
export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: parseIntInRange('PORT', env.PORT, 8090, 1, 65535),
    dataDir: path.resolve(env.DATA_DIR || '/app/data'),
    distDir: path.resolve(__dirname, 'dist'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    // Requests per minute per client IP on /api and /models (0 disables).
    rateLimitPerMinute: parseIntInRange('RATE_LIMIT_PER_MINUTE', env.RATE_LIMIT_PER_MINUTE, 600, 0, 1_000_000),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the lowercase extension (no dot) for a filename, or '' if none. */
export function extOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/** True for a plain, visible file name with a supported model extension. */
const isModelName = (name) => !name.startsWith('.') && ALLOWED_EXT.has(extOf(name));

/**
 * Resolve a user-supplied filename to an absolute path strictly inside
 * `dataDir`. Returns null if the name is unsafe or the extension is not allowed.
 *
 * Defends against: path traversal (../), absolute paths, encoded slashes,
 * sub-directory access, NUL bytes and disallowed extensions.
 */
export function resolveModelPath(rawName, dataDir) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > 255) return null;
  if (rawName.includes('\0')) return null;

  // A legitimate model filename is a single path component. If stripping the
  // directory part changes it, the caller tried to escape the data directory.
  const base = path.basename(rawName);
  if (base !== rawName || base.includes('\\')) return null;
  if (!isModelName(base)) return null; // also rejects '.', '..' and dotfiles

  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, base);
  // The resolved file must live directly inside the data directory.
  if (path.dirname(resolved) !== root) return null;
  return resolved;
}

/** True if `child` is `parent` itself or lies anywhere beneath it. */
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Follow symlinks for a model inside the data directory and return the real
 * path plus stats — or null unless it is a regular file whose real location is
 * still inside the data directory. Symlinks between files in the library keep
 * working; a link pointing elsewhere (e.g. "x.usdz -> /etc/passwd" or into the
 * app's own code) is treated as if it did not exist.
 */
async function realModelFile(realRoot, candidate) {
  try {
    const real = await fsp.realpath(candidate);
    if (!isWithin(realRoot, real)) return null;
    const stat = await fsp.stat(real);
    return stat.isFile() ? { real, stat } : null;
  } catch {
    return null; // missing, dangling or unreadable
  }
}

/** Real path of the data directory, or null if it does not exist. */
async function realDataRoot(root) {
  try {
    return await fsp.realpath(root);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Catalogue metadata for one model file. */
function describeModel(name, stat) {
  return {
    name,
    extension: extOf(name),
    size: stat.size,
    sizeMB: Math.round((stat.size / (1024 * 1024)) * 100) / 100,
    modified: stat.mtime.toISOString(),
    // The mtime query is a cache-buster: the file route is cached for an hour,
    // so replacing a model with the same name must yield a new URL.
    url: `/models/${encodeURIComponent(name)}?v=${Math.floor(stat.mtimeMs)}`,
  };
}

const sendJsonError = (res, status, error) => res.status(status).json({ error });

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
export function createApp({ dataDir, distDir, trustProxy = false, rateLimitPerMinute = 600 } = {}) {
  if (!dataDir || !distDir) throw new Error('createApp() requires dataDir and distDir');
  const root = path.resolve(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  // ---- Hardening headers on every response ---------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      // TLS is terminated by the reverse proxy (or absent on a LAN): HSTS
      // belongs there, where the HTTPS scheme is actually known.
      strictTransportSecurity: false,
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      xFrameOptions: { action: 'deny' },
    })
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  });

  // ---- Rate limiting (API + model downloads; static assets are exempt) -----
  if (rateLimitPerMinute > 0) {
    const limiter = rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: (req) => req.baseUrl === '/api' && req.path === '/health', // container healthchecks
      handler: (_req, res) => sendJsonError(res, 429, 'Too many requests, slow down'),
    });
    app.use(['/api', '/models'], limiter);
  }

  // API responses must never be served stale (the model list changes whenever
  // files are added to the data directory).
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Health probe — used by the Docker healthcheck.
  app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'usdz-viewer' });
  });

  // Model catalogue — metadata only, no file contents are read.
  app.get('/api/models', async (_req, res) => {
    try {
      const realRoot = await realDataRoot(root);
      if (!realRoot) {
        // Empty-state: the data directory has not been mounted/created yet.
        // (The absolute host path is logged at startup, never sent to clients.)
        return res.status(200).json({ models: [], count: 0, warning: 'data directory not found' });
      }

      const names = (await fsp.readdir(root)).filter(isModelName);
      const truncated = names.length > MAX_MODELS;
      const files = await Promise.all(names.slice(0, MAX_MODELS).map((name) => realModelFile(realRoot, path.join(root, name))));
      const models = names
        .slice(0, MAX_MODELS)
        .map((name, i) => files[i] && describeModel(name, files[i].stat))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

      const body = { models, count: models.length };
      if (truncated) body.warning = `only the first ${MAX_MODELS} files are listed`;
      res.status(200).json(body);
    } catch (err) {
      console.error('[api/models] failed to list models:', err);
      sendJsonError(res, 500, 'Failed to list models');
    }
  });

  // Unknown API routes get a JSON 404 rather than falling through to static.
  app.use('/api', (_req, res) => sendJsonError(res, 404, 'Not found'));

  // Stream a single model file. res.sendFile is range-aware and streamed — the
  // file is never buffered fully into memory.
  app.get('/models/:filename', async (req, res) => {
    const candidate = resolveModelPath(req.params.filename, root);
    if (!candidate) return sendJsonError(res, 400, 'Invalid or unsupported model filename');

    const realRoot = await realDataRoot(root).catch(() => null);
    const file = realRoot && (await realModelFile(realRoot, candidate));
    if (!file) return sendJsonError(res, 404, 'Model not found');

    res.setHeader('Content-Type', MIME_TYPES[extOf(candidate)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Security-Policy', MODEL_CSP);

    // Relative to the real data root so `send` only inspects the part we
    // control for dot-segments (the data dir itself may live under a dot dir).
    const relative = path.relative(realRoot, file.real);
    res.sendFile(relative, { root: realRoot, dotfiles: 'deny' }, (sendErr) => {
      if (sendErr && !res.headersSent) {
        // send() reports client-side problems (403/404/416…) via err.status;
        // only genuine server failures deserve an error log and a 500.
        const status = sendErr.status || sendErr.statusCode || 500;
        if (status >= 500) console.error('[models] send failed:', sendErr);
        res.removeHeader('Cache-Control');
        sendJsonError(res, status, status === 404 ? 'Model not found' : 'Failed to send model');
      } else if (sendErr && sendErr.code !== 'ECONNABORTED') {
        // Connection dropped mid-stream; nothing more we can do.
        console.warn('[models] stream aborted:', sendErr.message);
      }
    });
  });

  // Static frontend (built by Vite). Served after the API routes so it never
  // shadows them. index.html is returned for "/".
  app.use(
    express.static(distDir, {
      index: 'index.html',
      dotfiles: 'ignore',
      setHeaders(res, filePath) {
        // Hashed asset files can be cached aggressively; keep HTML revalidated.
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  // Plain 404 for everything else (no reflected request path).
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

  // Last-resort error handler: never leak stack traces or internal messages.
  // (Express identifies error handlers by their four-argument signature.)
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[server] unhandled error:', err);
    if (res.headersSent) return res.end();
    res
      .status(status)
      .type('text/plain')
      .send(status >= 500 ? 'Internal server error' : 'Bad request');
  });

  return app;
}

// ---------------------------------------------------------------------------
// Startup (only when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------
export function start(config = loadConfig()) {
  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`[usdz-viewer] listening on http://${config.host}:${config.port}`);
    console.log(`[usdz-viewer] data directory: ${config.dataDir}`);
    if (config.trustProxy !== false) console.log(`[usdz-viewer] trusting proxy: ${JSON.stringify(config.trustProxy)}`);
    if (!fs.existsSync(config.distDir)) {
      console.warn(`[usdz-viewer] WARNING: dist directory missing at ${config.distDir} — did you run "npm run build"?`);
    }
    if (!fs.existsSync(config.dataDir)) {
      console.warn(`[usdz-viewer] WARNING: data directory missing at ${config.dataDir} — /api/models will be empty.`);
    }
  });

  // Slow-client protection: requests here are bodiless GETs, so headers must
  // arrive promptly. (Responses — large model downloads — are not limited.)
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  // Graceful shutdown so "docker compose down" / restarts are clean.
  const shutdown = (signal) => {
    console.log(`[usdz-viewer] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    start();
  } catch (err) {
    console.error(`[usdz-viewer] ${err.message}`);
    process.exit(1);
  }
}
