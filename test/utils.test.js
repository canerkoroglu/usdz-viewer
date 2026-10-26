// Unit tests for the pure frontend helpers in src/utils.js and src/storage.js.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  stepDecimals,
  deepMerge,
  mergeKnown,
  isValidModelEntry,
  foldText,
  namesMatch,
  extOf,
  formatSize,
  formatPct,
  relTime,
  describeLoadError,
  materialsOf,
  texturesOf,
} from '../src/utils.js';
import { loadJSON, saveJSON } from '../src/storage.js';

describe('clamp / stepDecimals', () => {
  it('clamps into range', () => {
    assert.equal(clamp(5, 0, 1), 1);
    assert.equal(clamp(-5, 0, 1), 0);
    assert.equal(clamp(0.5, 0, 1), 0.5);
  });
  it('derives display decimals from a slider step', () => {
    assert.equal(stepDecimals(1), 0);
    assert.equal(stepDecimals(0.1), 1);
    assert.equal(stepDecimals(0.05), 2);
    assert.equal(stepDecimals(0.0001), 4);
    assert.equal(stepDecimals(1e-9), 6, 'capped at 6');
    assert.equal(stepDecimals(0), 0);
    assert.equal(stepDecimals(NaN), 0);
  });
});

describe('deepMerge()', () => {
  it('merges nested objects in place and keeps untouched keys', () => {
    const target = { a: { x: 1, y: 2 }, b: 1 };
    const inner = target.a;
    const out = deepMerge(target, { a: { y: 3 }, c: 4 });
    assert.equal(out, target);
    assert.equal(target.a, inner, 'nested object identity is preserved');
    assert.deepEqual(target, { a: { x: 1, y: 3 }, b: 1, c: 4 });
  });
  it('replaces arrays and primitives instead of merging them', () => {
    const target = { list: [1, 2, 3], n: { deep: true } };
    deepMerge(target, { list: [9], n: 5 });
    assert.deepEqual(target, { list: [9], n: 5 });
  });
});

describe('prototype-pollution safety', () => {
  it('deepMerge ignores __proto__ / constructor / prototype keys', () => {
    const target = { a: { b: 1 } };
    deepMerge(target, JSON.parse('{"__proto__": {"polluted": true}, "a": {"__proto__": {"polluted": true}}, "constructor": {"prototype": {"polluted": true}}}'));
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(target, { a: { b: 1 } });
  });
  it('deepMerge ignores non-object patches', () => {
    assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
    assert.deepEqual(deepMerge({ a: 1 }, 'abc'), { a: 1 });
  });
});

describe('mergeKnown() (untrusted input)', () => {
  const defaults = () => ({ env: { exposure: 1, toneMapping: 'neutral' }, shadow: { enabled: true }, preset: 'default' });
  it('takes known keys whose type matches', () => {
    const out = mergeKnown(defaults(), { env: { exposure: 1.5 }, shadow: { enabled: false }, preset: 'studio' });
    assert.deepEqual(out, { env: { exposure: 1.5, toneMapping: 'neutral' }, shadow: { enabled: false }, preset: 'studio' });
  });
  it('drops unknown keys, wrong types, non-finite numbers and arrays', () => {
    const out = mergeKnown(defaults(), {
      extra: 1,
      env: { exposure: '9', toneMapping: ['x'], injected: true },
      shadow: 'off',
      preset: { evil: true },
    });
    assert.deepEqual(out, defaults());
    assert.deepEqual(mergeKnown(defaults(), { env: { exposure: NaN } }).env.exposure, 1);
  });
  it('cannot pollute prototypes', () => {
    mergeKnown(defaults(), JSON.parse('{"__proto__": {"polluted": 1}, "env": {"__proto__": {"polluted": 1}}}'));
    assert.equal({}.polluted, undefined);
  });
  it('ignores non-object input', () => {
    assert.deepEqual(mergeKnown(defaults(), null), defaults());
    assert.deepEqual(mergeKnown(defaults(), [1, 2]), defaults());
  });
});

describe('isValidModelEntry()', () => {
  const good = { name: 'a.usdz', extension: 'usdz', size: 10, modified: '2026-01-01T00:00:00.000Z', url: '/models/a.usdz?v=1' };
  it('accepts a well-formed same-origin entry', () => {
    assert.ok(isValidModelEntry(good));
  });
  it('rejects malformed or off-origin entries', () => {
    for (const bad of [
      null,
      'x',
      { ...good, url: 'https://evil.example/x.usdz' },
      { ...good, url: '//evil.example/models/x' },
      { ...good, name: '' },
      { ...good, size: -1 },
      { ...good, size: '10' },
      { ...good, modified: 5 },
    ]) {
      assert.ok(!isValidModelEntry(bad), JSON.stringify(bad));
    }
  });
});

describe('text helpers', () => {
  it('foldText strips accents and case', () => {
    assert.equal(foldText('Küçük KÖŞE'), 'kucuk kose');
  });
  it('namesMatch is equality or containment, accent/case-insensitive', () => {
    assert.ok(namesMatch('Walk', 'walk'));
    assert.ok(namesMatch('Armature|Walk_Cycle', 'walk'));
    assert.ok(namesMatch('run', 'Run_Fast'));
    assert.ok(namesMatch('Koşu', 'kosu'));
    assert.ok(!namesMatch('walk', 'run'));
    assert.ok(!namesMatch('', 'walk'));
    assert.ok(!namesMatch(undefined, 'walk'));
  });
  it('extOf returns the lowercase extension or empty string', () => {
    assert.equal(extOf('Chair.USDZ'), 'usdz');
    assert.equal(extOf('a.b.usda'), 'usda');
    assert.equal(extOf('textures/wood.PNG'), 'png');
    assert.equal(extOf('noext'), '');
    assert.equal(extOf('dir.v2/file'), '', 'a dot in a directory is not an extension');
    assert.equal(extOf('.hidden'), '', 'dotfiles have no extension');
    assert.equal(extOf('usdz'), '', 'a bare word is not an extension');
  });
});

describe('formatting', () => {
  it('formatSize picks a sensible unit', () => {
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(2048), '2.0 KB');
    assert.equal(formatSize(5 * 1024 * 1024), '5.00 MB');
  });
  it('formatPct only reports computable progress', () => {
    assert.equal(formatPct({ lengthComputable: true, loaded: 1, total: 4 }), ' 25%');
    assert.equal(formatPct({ lengthComputable: false, loaded: 1, total: 4 }), '');
    assert.equal(formatPct(undefined), '');
  });
  it('relTime describes recent times relatively', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    assert.equal(relTime('2026-01-10T11:59:50Z', now), 'just now');
    assert.equal(relTime('2026-01-10T11:30:00Z', now), '30 min ago');
    assert.equal(relTime('2026-01-10T07:00:00Z', now), '5 h ago');
    assert.equal(relTime('2026-01-07T12:00:00Z', now), '3 d ago');
    assert.equal(relTime('not a date', now), '');
  });
});

describe('describeLoadError()', () => {
  const cases = [
    [new Error('HTTP 404 Not Found'), /was not found on the server/],
    [new Error('fetch for "x" responded with 503: Service Unavailable'), /server failed/],
    [new TypeError('Failed to fetch'), /Network error/],
    [new Error('Invalid USDZ package'), /could not be parsed/],
    ['something odd', /Failed to load "m.usdz"\. \(something odd\)/],
    [null, /unknown error/],
  ];
  for (const [err, re] of cases) {
    it(`maps ${JSON.stringify(String(err?.message ?? err))}`, () => {
      assert.match(describeLoadError(err, 'm.usdz'), re);
    });
  }
});

describe('material helpers', () => {
  const tex = { isTexture: true };
  it('materialsOf normalises single, multi and missing materials', () => {
    const m = { id: 1 };
    assert.deepEqual(materialsOf({ material: m }), [m]);
    assert.deepEqual(materialsOf({ material: [m, null, m] }), [m, m]);
    assert.deepEqual(materialsOf({}), []);
  });
  it('texturesOf finds texture-valued properties only', () => {
    assert.deepEqual(texturesOf({ map: tex, color: { r: 1 }, normalMap: null, roughness: 0.5 }), [tex]);
  });
});

describe('storage helpers', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
  });
  it('round-trips JSON', () => {
    saveJSON('k', { a: 1 });
    assert.deepEqual(loadJSON('k'), { a: 1 });
  });
  it('falls back on missing, corrupt or null values', () => {
    assert.deepEqual(loadJSON('missing', { d: 1 }), { d: 1 });
    store.set('bad', '{not json');
    assert.deepEqual(loadJSON('bad'), {});
    store.set('null', 'null');
    assert.deepEqual(loadJSON('null'), {});
  });
  it('never throws when storage is unavailable', () => {
    globalThis.localStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
    };
    assert.deepEqual(loadJSON('k', []), []);
    assert.doesNotThrow(() => saveJSON('k', 1));
  });
});
