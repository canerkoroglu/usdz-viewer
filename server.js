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
 * `createApp()` builds the Express app for a given data/dist directory so the
 * test-suite can run instances against fixture folders; running this file
 * directly (`node server.js`) starts the real server.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT || '8090', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/app/data');
const DIST_DIR = path.resolve(__dirname, 'dist');

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the lowercase extension (no dot) for a filename, or '' if none. */
export function extOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * Resolve a user-supplied filename to an absolute path strictly inside
 * `dataDir`. Returns null if the name is unsafe or the extension is not allowed.
 *
 * Defends against: path traversal (../), absolute paths, encoded slashes,
 * sub-directory access, NUL bytes and disallowed extensions.
 */
export function resolveModelPath(rawName, dataDir = DATA_DIR) {
  if (typeof rawName !== 'string' || rawName.length === 0) return null;
  if (rawName.includes('\0')) return null;

  // A legitimate model filename is a single path component. If stripping the
  // directory part changes it, the caller tried to escape the data directory.
  const base = path.basename(rawName);
  if (base !== rawName) return null;
  if (base === '.' || base === '..') return null;
  if (base.startsWith('.')) return null; // dotfiles are never models

  if (!ALLOWED_EXT.has(extOf(base))) return null;

  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, base);

  // The resolved file must live directly inside the data directory.
  if (path.dirname(resolved) !== root) return null;

  return resolved;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
export function createApp({ dataDir = DATA_DIR, distDir = DIST_DIR } = {}) {
  const root = path.resolve(dataDir);
  const app = express();
  app.disable('x-powered-by');

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
      let entries;
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') {
          // Empty-state: the data directory has not been mounted/created yet.
          return res.status(200).json({ models: [], count: 0, dataDir: root, warning: 'data directory not found' });
        }
        throw err;
      }

      const models = [];
      for (const entry of entries) {
        // Follow both files and symlinks-to-files; skip directories/others.
        const name = entry.name;
        if (name.startsWith('.') || !ALLOWED_EXT.has(extOf(name))) continue;

        const full = path.join(root, name);
        let stat;
        try {
          stat = await fsp.stat(full); // stat (not lstat) so symlinked files count
        } catch {
          continue; // unreadable / dangling — skip rather than fail the whole list
        }
        if (!stat.isFile()) continue;

        const size = stat.size;
        models.push({
          name,
          extension: extOf(name),
          size,
          sizeMB: Math.round((size / (1024 * 1024)) * 100) / 100,
          modified: stat.mtime.toISOString(),
          // The mtime query is a cache-buster: the file route is cached for an
          // hour, so replacing a model with the same name must yield a new URL.
          url: `/models/${encodeURIComponent(name)}?v=${Math.floor(stat.mtimeMs)}`,
        });
      }

      models.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));

      res.status(200).json({ models, count: models.length });
    } catch (err) {
      console.error('[api/models] failed to list models:', err);
      res.status(500).json({ error: 'Failed to list models', detail: err.message });
    }
  });

  // Stream a single model file. Uses res.sendFile (range-aware, streamed — the
  // file is never buffered fully into memory).
  app.get('/models/:filename', (req, res) => {
    const resolved = resolveModelPath(req.params.filename, root);
    if (!resolved) {
      return res.status(400).json({ error: 'Invalid or unsupported model filename' });
    }

    fs.stat(resolved, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        return res.status(404).json({ error: 'Model not found' });
      }

      res.setHeader('Content-Type', MIME_TYPES[extOf(resolved)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      res.sendFile(resolved, { dotfiles: 'deny' }, (sendErr) => {
        if (sendErr && !res.headersSent) {
          // send() reports client-side problems (403/404/416…) via err.status;
          // only genuine server failures deserve an error log and a 500.
          const status = sendErr.status || sendErr.statusCode || 500;
          if (status >= 500) console.error('[models] send failed:', sendErr);
          res.status(status).json({ error: status === 404 ? 'Model not found' : 'Failed to send model' });
        } else if (sendErr) {
          // Connection dropped mid-stream; nothing more we can do.
          console.warn('[models] stream aborted:', sendErr.message);
        }
      });
    });
  });

  // Static frontend (built by Vite). Served after the API routes so it never
  // shadows them. index.html is returned for "/".
  app.use(
    express.static(distDir, {
      index: 'index.html',
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

  return app;
}

// ---------------------------------------------------------------------------
// Startup (only when executed directly, not when imported by tests)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const app = createApp();
  const server = app.listen(PORT, HOST, () => {
    console.log(`[usdz-viewer] listening on http://${HOST}:${PORT}`);
    console.log(`[usdz-viewer] data directory: ${DATA_DIR}`);
    if (!fs.existsSync(DIST_DIR)) {
      console.warn(`[usdz-viewer] WARNING: dist directory missing at ${DIST_DIR} — did you run "npm run build"?`);
    }
    if (!fs.existsSync(DATA_DIR)) {
      console.warn(`[usdz-viewer] WARNING: data directory missing at ${DATA_DIR} — /api/models will be empty.`);
    }
  });

  // Graceful shutdown so "docker compose down" / restarts are clean.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[usdz-viewer] received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      // Force-exit if connections linger.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
