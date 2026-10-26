// Unit tests for the USD helpers in src/usd.js (no browser needed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

import { makeZipGuard, isCrate, isZip, asArrayBuffer, stripVariantSegments, enumerateVariants, propagateStrongBindings, parseLayers, composeUSD } from '../src/usd.js';

const TRIANGLE_USDA = `#usda 1.0
def Xform "Root"
{
    def Mesh "Tri"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}
`;
const toBuffer = (u8) => asArrayBuffer(u8);

describe('format sniffing', () => {
  it('recognises crate and zip magic bytes', () => {
    assert.ok(isCrate(strToU8('PXR-USDC....')));
    assert.ok(!isCrate(strToU8('PXR-USD')), 'too short');
    assert.ok(!isCrate(strToU8('#usda 1.0')));
    assert.ok(isZip(strToU8('PK\u0003\u0004')));
    assert.ok(!isZip(strToU8('#usda')));
  });
  it('asArrayBuffer copies only when given a sub-view', () => {
    const whole = new Uint8Array([1, 2, 3]);
    assert.equal(asArrayBuffer(whole), whole.buffer);
    const view = new Uint8Array(whole.buffer, 1, 2);
    assert.deepEqual([...new Uint8Array(asArrayBuffer(view))], [2, 3]);
  });
  it('stripVariantSegments removes {set=option} path segments', () => {
    assert.equal(stripVariantSegments('/Root/{color=red}/Mesh'), '/Root/Mesh');
    assert.equal(stripVariantSegments('/Root/{a=x}/B/{c=}/D'), '/Root/B/D');
  });
});

describe('enumerateVariants()', () => {
  const specs = {
    '/Car': { fields: { variantSetChildren: ['paint', 'trim', 'single'], variantSelection: { paint: 'blue' } } },
    '/Car/{paint=}': { fields: { variantChildren: ['red', 'blue'] } },
    '/Car/{trim=}': { fields: { variantChildren: ['base', 'sport'] } },
    '/Car/{single=}': { fields: { variantChildren: ['only'] } },
    '/Bike': { fields: { variantSetChildren: ['paint'] } },
    '/Bike/{paint=}': { fields: { variantChildren: ['green'] } },
  };
  it('merges same-named sets, keeps the authored selection and drops single-option sets', () => {
    assert.deepEqual(enumerateVariants({ specsByPath: specs }), [
      { name: 'paint', options: ['red', 'blue', 'green'], selected: 'blue' },
      { name: 'trim', options: ['base', 'sport'], selected: 'base' },
    ]);
  });
  it('tolerates missing data', () => {
    assert.deepEqual(enumerateVariants(null), []);
    assert.deepEqual(enumerateVariants({}), []);
  });
});

describe('propagateStrongBindings()', () => {
  it('pushes strongerThanDescendants bindings down to descendant meshes', () => {
    const specs = {
      '/Root': { fields: {} },
      '/Root.material:binding': { fields: { bindMaterialAs: 'strongerThanDescendants', targetPaths: ['/Mats/Red'] } },
      '/Root/Body': { fields: { typeName: 'Mesh', properties: ['points'] } },
      '/Root/Group': { fields: { typeName: 'Xform' } },
      '/Other/Mesh': { fields: { typeName: 'Mesh' } },
    };
    propagateStrongBindings(specs);
    assert.deepEqual(specs['/Root/Body.material:binding'].fields, { bindMaterialAs: 'weakerThanDescendants', targetPaths: ['/Mats/Red'] });
    assert.deepEqual(specs['/Root/Body'].fields.properties, ['points', 'material:binding']);
    assert.equal(specs['/Root/Group.material:binding'], undefined, 'non-mesh prims untouched');
    assert.equal(specs['/Other/Mesh.material:binding'], undefined, 'meshes outside the subtree untouched');
  });
  it('lets the deepest strong ancestor win', () => {
    const specs = {
      '/A.material:binding': { fields: { bindMaterialAs: 'strongerThanDescendants', targetPaths: ['/M/Outer'] } },
      '/A/B.material:binding': { fields: { bindMaterialAs: 'strongerThanDescendants', targetPaths: ['/M/Inner'] } },
      '/A/B/Mesh': { fields: { typeName: 'Mesh' } },
    };
    propagateStrongBindings(specs);
    assert.deepEqual(specs['/A/B/Mesh.material:binding'].fields.targetPaths, ['/M/Inner']);
  });
  it('ignores weaker bindings and empty input', () => {
    const specs = {
      '/A.material:binding': { fields: { targetPaths: ['/M/X'] } },
      '/A/Mesh': { fields: { typeName: 'Mesh' } },
    };
    propagateStrongBindings(specs);
    assert.equal(specs['/A/Mesh.material:binding'], undefined);
    assert.doesNotThrow(() => propagateStrongBindings(undefined));
  });
});

describe('parseLayers() / composeUSD()', () => {
  it('composes a USDA file into a group containing the mesh', () => {
    const { group, variants } = composeUSD(toBuffer(strToU8(TRIANGLE_USDA)));
    const meshes = [];
    group.traverse((o) => o.isMesh && meshes.push(o));
    assert.equal(meshes.length, 1);
    assert.equal(meshes[0].name, 'Tri');
    assert.deepEqual(variants, []);
  });
  it('reads a USDZ package: root layer first, images kept as raw bytes', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const zip = zipSync({ 'scene.usda': strToU8(TRIANGLE_USDA), 'tex/wood.png': png, 'readme.txt': strToU8('ignored') });
    const { data, assets, basePath } = parseLayers(toBuffer(zip));
    assert.ok(data?.specsByPath, 'root layer parsed');
    assert.equal(basePath, '');
    assert.deepEqual([...assets['tex/wood.png']], [...png]);
    assert.equal(assets['readme.txt'], undefined, 'non-USD, non-image entries are skipped');
  });
  it('rejects USDZ packages whose first entry is not a layer', () => {
    const zip = zipSync({ 'tex.png': new Uint8Array([1]), 'scene.usda': strToU8(TRIANGLE_USDA) });
    assert.throws(() => parseLayers(toBuffer(zip)), /first entry/);
  });
  it('rejects empty USDZ packages', () => {
    assert.throws(() => parseLayers(toBuffer(zipSync({}))), /Empty USDZ/);
  });
});

describe('makeZipGuard() (zip-bomb protection)', () => {
  const limits = { maxEntries: 3, maxEntryBytes: 100, maxTotalBytes: 150 };
  it('accepts layers and images within limits and skips everything else', () => {
    const g = makeZipGuard(limits);
    assert.equal(g.filter({ name: 'scene.usda', originalSize: 50 }), true);
    assert.equal(g.filter({ name: 'readme.txt', originalSize: 10_000 }), false, 'skipped, never inflated');
    assert.equal(g.filter({ name: 'tex/a.png', originalSize: 90 }), true);
    assert.equal(g.first, 'scene.usda');
  });
  it('rejects oversized entries before inflating', () => {
    assert.throws(() => makeZipGuard(limits).filter({ name: 'big.usdc', originalSize: 101 }), /too large/);
  });
  it('rejects archives whose total unpacked size is too large', () => {
    const g = makeZipGuard(limits);
    g.filter({ name: 'a.usda', originalSize: 100 });
    assert.throws(() => g.filter({ name: 'b.png', originalSize: 60 }), /too large once unpacked/);
  });
  it('rejects archives with too many entries', () => {
    const g = makeZipGuard(limits);
    for (let i = 0; i < 3; i++) g.filter({ name: `${i}.txt`, originalSize: 1 });
    assert.throws(() => g.filter({ name: 'x.txt', originalSize: 1 }), /too many entries/);
  });
  it('keeps the spec root even when the first entry is skipped', () => {
    const zip = zipSync({ 'readme.txt': strToU8('x'), 'scene.usda': strToU8(TRIANGLE_USDA) });
    assert.throws(() => parseLayers(toBuffer(zip)), /first entry \("readme\.txt"\)/);
  });
});
