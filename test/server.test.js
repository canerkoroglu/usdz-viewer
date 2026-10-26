// Server integration tests — run with `npm test` (Node's built-in test runner,
// no extra dependencies). Each suite spins up the Express app against a
// temporary fixture directory and talks to it over real HTTP.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp, resolveModelPath, parseTrustProxy, loadConfig, MAX_MODELS } from '../server.js';

const UNICODE_NAME = 'Küçük Küp (köşe) [v2].usdz';
const ZEBRA_BYTES = 'PK\x03\x04zebra-archive-bytes'; // starts with a zip local-file header

/** Try to create a symlink; returns false where the OS/user cannot (e.g. Windows without privileges). */
async function trySymlink(target, linkPath) {
  try {
    await fsp.symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

async function makeFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usdz-viewer-test-'));
  await fsp.writeFile(path.join(dir, 'Zebra.usdz'), Buffer.from(ZEBRA_BYTES, 'latin1'));
  await fsp.writeFile(path.join(dir, 'apple.usda'), '#usda 1.0\n');
  await fsp.writeFile(path.join(dir, 'Bravo.usdc'), Buffer.from('PXR-USDCcrate'));
  await fsp.writeFile(path.join(dir, 'model 10.usd'), 'ten');
  await fsp.writeFile(path.join(dir, 'model 9.usd'), 'nine');
  await fsp.writeFile(path.join(dir, UNICODE_NAME), Buffer.from('PK-unicode'));
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a model');
  await fsp.writeFile(path.join(dir, '.hidden.usdz'), 'dotfile');
  await fsp.mkdir(path.join(dir, 'sub'));
  await fsp.writeFile(path.join(dir, 'sub', 'inner.usdz'), 'nested');
  await fsp.mkdir(path.join(dir, 'folder.usdz')); // a directory with a model-like name
  return dir;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('resolveModelPath()', () => {
  const root = path.resolve('/srv/data');
  it('accepts a plain filename with an allowed extension', () => {
    assert.equal(resolveModelPath('chair.usdz', root), path.join(root, 'chair.usdz'));
    assert.equal(resolveModelPath('Scene.USDA', root), path.join(root, 'Scene.USDA'));
    assert.equal(resolveModelPath(UNICODE_NAME, root), path.join(root, UNICODE_NAME));
  });
  it('rejects traversal, sub-paths, absolute paths, NUL bytes and dot names', () => {
    for (const bad of ['../server.js', '..', '.', 'sub/inner.usdz', '/etc/passwd.usdz', 'a\0.usdz', '', 'x/../y.usdz', '.hidden.usdz']) {
      assert.equal(resolveModelPath(bad, root), null, `should reject ${JSON.stringify(bad)}`);
    }
  });
  it('rejects disallowed extensions', () => {
    for (const bad of ['notes.txt', 'archive.zip', 'noext', 'model.usdz.exe']) {
      assert.equal(resolveModelPath(bad, root), null, `should reject ${bad}`);
    }
  });
});

describe('HTTP API', () => {
  let dir, server, base;
  before(async () => {
    dir = await makeFixture();
    ({ server, base } = await listen(createApp({ dataDir: dir, distDir: path.join(dir, 'no-dist'), rateLimitPerMinute: 0 })));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('GET /api/health is ok and never cached', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { status: 'ok', service: 'usdz-viewer' });
  });

  it('GET /api/models lists only supported top-level files, sorted naturally', async () => {
    const res = await fetch(`${base}/api/models`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { models, count } = await res.json();
    const names = models.map((m) => m.name);
    assert.deepEqual(names, ['apple.usda', 'Bravo.usdc', UNICODE_NAME, 'model 9.usd', 'model 10.usd', 'Zebra.usdz']);
    assert.equal(count, models.length);
    assert.ok(!names.includes('notes.txt'), 'non-model extension excluded');
    assert.ok(!names.includes('.hidden.usdz'), 'dotfiles excluded');
    assert.ok(!names.includes('folder.usdz'), 'directories excluded');
    assert.ok(!names.includes('inner.usdz'), 'nested files excluded');
  });

  it('model entries carry metadata and a cache-busting, URL-encoded url', async () => {
    const { models } = await (await fetch(`${base}/api/models`)).json();
    const zebra = models.find((m) => m.name === 'Zebra.usdz');
    assert.equal(zebra.extension, 'usdz');
    assert.equal(zebra.size, Buffer.byteLength(ZEBRA_BYTES));
    assert.equal(typeof zebra.sizeMB, 'number');
    assert.match(zebra.url, /^\/models\/Zebra\.usdz\?v=\d+$/);
    const uni = models.find((m) => m.name === UNICODE_NAME);
    assert.equal(uni.url.split('?')[0], `/models/${encodeURIComponent(UNICODE_NAME)}`);
  });

  it('GET /models/:name streams the file with the right MIME and cache headers', async () => {
    const cases = [
      ['Zebra.usdz', 'model/vnd.usdz+zip', ZEBRA_BYTES],
      ['apple.usda', 'text/plain; charset=utf-8', '#usda 1.0\n'],
      ['Bravo.usdc', 'application/octet-stream', 'PXR-USDCcrate'],
      ['model 9.usd', 'model/vnd.usd', 'nine'],
    ];
    for (const [name, mime, body] of cases) {
      const res = await fetch(`${base}/models/${encodeURIComponent(name)}?v=123`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get('content-type'), mime, name);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(await res.text(), body, name);
    }
  });

  it('round-trips a Unicode filename with spaces, parentheses and brackets', async () => {
    const { models } = await (await fetch(`${base}/api/models`)).json();
    const uni = models.find((m) => m.name === UNICODE_NAME);
    const res = await fetch(base + uni.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'PK-unicode');
  });

  it('supports HTTP range requests (large files are streamed, not buffered)', async () => {
    const res = await fetch(`${base}/models/Zebra.usdz`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), 'PK');
  });

  it('blocks path traversal and sub-directory access with 400', async () => {
    for (const p of ['..%2Fserver.js', '%2e%2e%2F%2e%2e%2Fetc%2Fpasswd.usdz', 'sub%2Finner.usdz', '%2Fetc%2Fpasswd.usdz']) {
      const res = await fetch(`${base}/models/${p}`);
      assert.equal(res.status, 400, p);
    }
  });

  it('rejects disallowed extensions with 400 and missing files with 404', async () => {
    assert.equal((await fetch(`${base}/models/notes.txt`)).status, 400);
    assert.equal((await fetch(`${base}/models/ghost.usdz`)).status, 404);
    assert.equal((await fetch(`${base}/models/folder.usdz`)).status, 404, 'a directory is not a model');
  });

  it('refuses to serve dotfiles even with an allowed extension', async () => {
    const res = await fetch(`${base}/models/.hidden.usdz`);
    assert.equal(res.status, 400);
  });
});

describe('HTTP API without a data directory', () => {
  let server, base;
  before(async () => {
    ({ server, base } = await listen(createApp({ dataDir: path.join(os.tmpdir(), 'usdz-viewer-does-not-exist'), distDir: '/nonexistent', rateLimitPerMinute: 0 })));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
  });

  it('returns an empty list with a warning instead of failing', async () => {
    const res = await fetch(`${base}/api/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.models, []);
    assert.equal(body.count, 0);
    assert.match(body.warning, /not found/);
    assert.equal(body.dataDir, undefined, 'host paths are not exposed');
  });
});

describe('configuration', () => {
  it('parses TRUST_PROXY safely (default: trust nothing)', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('1'), 1);
    assert.deepEqual(parseTrustProxy('loopback, 172.16.0.0/12'), ['loopback', '172.16.0.0/12']);
  });
  it('validates numeric settings and fails fast on bad values', () => {
    const cfg = loadConfig({ PORT: '9000', DATA_DIR: '/srv/models' });
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.dataDir, path.resolve('/srv/models'));
    assert.equal(cfg.rateLimitPerMinute, 600);
    assert.equal(cfg.trustProxy, false);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ RATE_LIMIT_PER_MINUTE: '-1' }), /Invalid RATE_LIMIT_PER_MINUTE/);
  });
  it('requires explicit directories', () => {
    assert.throws(() => createApp({}), /requires dataDir and distDir/);
  });
});

describe('security headers and hardening', () => {
  let dir, outside, server, base, linked;
  before(async () => {
    dir = await makeFixture();
    outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'usdz-viewer-outside-'));
    await fsp.writeFile(path.join(outside, 'secret.usdz'), 'TOP-SECRET');
    // A link that escapes the data directory, and one that stays inside it.
    linked =
      (await trySymlink(path.join(outside, 'secret.usdz'), path.join(dir, 'escape.usdz'))) &&
      (await trySymlink(path.join(dir, 'Zebra.usdz'), path.join(dir, 'alias.usdz'))) &&
      (await trySymlink('/etc/hostname', path.join(dir, 'host.usda')));
    const dist = path.join(dir, 'dist');
    await fsp.mkdir(dist);
    await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>t</title>');
    await fsp.writeFile(path.join(dist, '.env'), 'SECRET=1');
    ({ server, base } = await listen(createApp({ dataDir: dir, distDir: dist, rateLimitPerMinute: 0 })));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  });

  it('serves the app with a strict CSP and hardening headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      assert.ok(csp.includes(directive), `CSP has ${directive}`);
    }
    assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'), 'no unsafe-* sources');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.match(res.headers.get('permissions-policy'), /xr-spatial-tracking=\(self\)/);
    assert.match(res.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('strict-transport-security'), null, 'HSTS is left to the TLS terminator');
  });

  it('serves model files as sandboxed, inert data', async () => {
    const res = await fetch(`${base}/models/apple.usda`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('never follows symlinks out of the data directory', async (t) => {
    if (!linked) return t.skip('symlinks unavailable on this platform');
    const res = await fetch(`${base}/models/escape.usdz`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes('TOP-SECRET'));
    assert.equal((await fetch(`${base}/models/host.usda`)).status, 404);
    const { models } = await (await fetch(`${base}/api/models`)).json();
    const names = models.map((m) => m.name);
    assert.ok(!names.includes('escape.usdz') && !names.includes('host.usda'), 'escaping links are not listed');
  });

  it('still serves symlinks that stay inside the data directory', async (t) => {
    if (!linked) return t.skip('symlinks unavailable on this platform');
    const res = await fetch(`${base}/models/alias.usdz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), ZEBRA_BYTES);
  });

  it('does not serve dotfiles from the frontend directory', async () => {
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  });

  it('answers unknown routes with a plain 404 that does not reflect the path', async () => {
    const api = await fetch(`${base}/api/does-not-exist`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: 'Not found' });
    const page = await fetch(`${base}/%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    assert.equal(page.status, 404);
    assert.ok(!(await page.text()).includes('script'));
  });

  it('rejects malformed percent-encoding without leaking internals', async () => {
    const res = await fetch(`${base}/models/%E0%A4%A`);
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.ok(!/at |node_modules|URIError/.test(text), 'no stack trace in the response');
  });

  it('rejects over-long names and Windows-style separators', async () => {
    assert.equal((await fetch(`${base}/models/${'a'.repeat(300)}.usdz`)).status, 400);
    assert.equal((await fetch(`${base}/models/..%5Cserver.js`)).status, 400);
    assert.equal(resolveModelPath('..\\x.usdz', dir), null);
  });

  it('does not expose server paths or error details in API errors', async () => {
    const body = await (await fetch(`${base}/api/models`)).json();
    assert.ok(!JSON.stringify(body).includes(os.tmpdir()), 'no absolute paths in the catalogue');
  });
});

describe('data directory under a dot-directory', () => {
  let parent, server, base;
  before(async () => {
    parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'usdz-viewer-dot-'));
    const data = path.join(parent, '.library', 'models');
    await fsp.mkdir(data, { recursive: true });
    await fsp.writeFile(path.join(data, 'cube.usda'), '#usda 1.0\n');
    ({ server, base } = await listen(createApp({ dataDir: data, distDir: path.join(parent, 'none'), rateLimitPerMinute: 0 })));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await fsp.rm(parent, { recursive: true, force: true });
  });
  it('still serves models (dot-segment checks only apply below the data root)', async () => {
    const res = await fetch(`${base}/models/cube.usda`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '#usda 1.0\n');
  });
});

describe('rate limiting', () => {
  let dir, server, base;
  before(async () => {
    dir = await makeFixture();
    ({ server, base } = await listen(createApp({ dataDir: dir, distDir: path.join(dir, 'none'), rateLimitPerMinute: 3 })));
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
  });
  it('throttles API and model requests per client with standard headers', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/models/apple.usda`);
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    const res = await fetch(`${base}/api/models`);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'Too many requests, slow down' });
    assert.ok(res.headers.get('ratelimit-policy'), 'IETF RateLimit-Policy header present');
  });
  it('never throttles the health probe', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });
});

describe('catalogue size cap', () => {
  it('is a sane bound', () => {
    assert.ok(MAX_MODELS >= 1000 && MAX_MODELS <= 100_000);
  });
});
