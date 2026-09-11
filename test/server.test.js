// Server integration tests — run with `npm test` (Node's built-in test runner,
// no extra dependencies). Each suite spins up the Express app against a
// temporary fixture directory and talks to it over real HTTP.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createApp, resolveModelPath } from '../server.js';

const UNICODE_NAME = 'Küçük Küp (köşe) [v2].usdz';

async function makeFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usdz-viewer-test-'));
  await fsp.writeFile(path.join(dir, 'Zebra.usdz'), Buffer.from('PKzebra-archive-bytes'));
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
    ({ server, base } = await listen(createApp({ dataDir: dir, distDir: path.join(dir, 'no-dist') })));
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
    assert.equal(zebra.size, Buffer.byteLength('PKzebra-archive-bytes'));
    assert.equal(typeof zebra.sizeMB, 'number');
    assert.match(zebra.url, /^\/models\/Zebra\.usdz\?v=\d+$/);
    const uni = models.find((m) => m.name === UNICODE_NAME);
    assert.equal(uni.url.split('?')[0], `/models/${encodeURIComponent(UNICODE_NAME)}`);
  });

  it('GET /models/:name streams the file with the right MIME and cache headers', async () => {
    const cases = [
      ['Zebra.usdz', 'model/vnd.usdz+zip', 'PKzebra-archive-bytes'],
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
    ({ server, base } = await listen(createApp({ dataDir: path.join(os.tmpdir(), 'usdz-viewer-does-not-exist'), distDir: '/nonexistent' })));
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
  });
});
