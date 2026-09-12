// MaterialX fallback for three.js's USD composer.
//
// The composer understands UsdUVTexture nodes wired directly into a
// UsdPreviewSurface. Many exporters instead author small MaterialX graphs
// (ND_image → ND_rgbtohsv → … → ND_mix) — e.g. a "recolour" material variant —
// which the composer cannot follow, leaving the input untextured (white).
//
// This module resolves each mesh's bound material from the parsed spec table,
// finds surface inputs that are driven by such graphs, evaluates the graph per
// pixel with a small MaterialX node set, bakes the result to a canvas and
// assigns it as the material's map. Unsupported nodes throw; the caller treats
// that as "leave the material as the composer built it".

import { CanvasTexture, SRGBColorSpace, NoColorSpace, RepeatWrapping } from 'three';

const MAX_BAKE = 2048; // per-side cap: keeps CPU/GPU cost sane on headsets
const REL = '.material:binding';

// PreviewSurface input -> three.js material slot
const SLOTS = {
  diffuseColor: { prop: 'map', srgb: true, channels: 3 },
  emissiveColor: { prop: 'emissiveMap', srgb: true, channels: 3 },
  normal: { prop: 'normalMap', srgb: false, channels: 3, imageOnly: true },
  roughness: { prop: 'roughnessMap', srgb: false, channels: 1, scalar: 'roughness' },
  metallic: { prop: 'metalnessMap', srgb: false, channels: 1, scalar: 'metalness' },
  occlusion: { prop: 'aoMap', srgb: false, channels: 1 },
};

const cache = new Map(); // bake key -> HTMLCanvasElement
export function clearMaterialXCache() {
  cache.clear();
}

const stripVariantSegments = (p) => p.replace(/\/\{[^}]*\}/g, '');
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const toVec = (v) => (Array.isArray(v) ? v.map(Number) : typeof v === 'number' ? [v] : v && typeof v === 'object' && 'x' in v ? [v.x, v.y, v.z ?? 0] : [0]);

function variantSegmentsMatch(path, selections) {
  for (const m of path.matchAll(/\/\{([^=}]+)=([^}]*)\}/g)) if (selections[m[1]] !== m[2]) return false;
  return true;
}

// composed mesh path -> bound material path, honouring the selected variants
// (variant-scoped bindings override base ones).
function resolveBindings(specs, selections) {
  const base = new Map();
  const scoped = new Map();
  for (const k in specs) {
    if (!k.endsWith(REL)) continue;
    const target = specs[k]?.fields?.targetPaths?.[0];
    if (!target) continue;
    const prim = k.slice(0, -REL.length);
    if (prim.includes('/{')) {
      if (variantSegmentsMatch(prim, selections)) scoped.set(stripVariantSegments(prim), target);
    } else base.set(prim, target);
  }
  return new Map([...base, ...scoped]);
}

// Match a composed mesh to a spec path by its trailing name segments.
function materialPathFor(mesh, bindings) {
  const segs = [];
  for (let o = mesh; o && !o.isScene; o = o.parent) segs.unshift(o.name || '');
  let best = null;
  let bestScore = 0;
  for (const [path, target] of bindings) {
    const ps = path.split('/').filter(Boolean);
    let score = 0;
    for (let i = 1; i <= Math.min(ps.length, segs.length); i++) {
      if (ps[ps.length - i] === segs[segs.length - i]) score++;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  return bestScore > 0 ? best : null;
}

// Surface shader kinds we understand and how their inputs map to slots.
const SURFACE_KINDS = [
  { match: (id) => id.includes('PreviewSurface'), inputs: { diffuseColor: 'diffuseColor', emissiveColor: 'emissiveColor', normal: 'normal', roughness: 'roughness', metallic: 'metallic', occlusion: 'occlusion' } },
  { match: (id) => id.includes('realitykit_pbr_surfaceshader'), inputs: { baseColor: 'diffuseColor', emissiveColor: 'emissiveColor', normal: 'normal', roughness: 'roughness', metallic: 'metallic', ambientOcclusion: 'occlusion' } },
  { match: (id) => id.includes('realitykit_unlit_surfaceshader'), inputs: { color: 'diffuseColor' }, unlit: true },
];

function findShaderNodes(specs, matPath) {
  const prefix = matPath + '/';
  const out = [];
  for (const k in specs) {
    if (!k.startsWith(prefix)) continue;
    const rest = k.slice(prefix.length);
    if (rest.includes('/') || rest.includes('.')) continue;
    const id = specs[k + '.info:id']?.fields?.default;
    if (typeof id === 'string') out.push({ path: k, id });
  }
  return out;
}

function findSurfaceShader(specs, matPath) {
  for (const node of findShaderNodes(specs, matPath)) {
    const kind = SURFACE_KINDS.find((s) => s.match(node.id));
    if (kind) return { path: node.path, ...kind };
  }
  return null;
}

const parseConn = (c) => {
  const i = c.indexOf('.outputs:');
  return i < 0 ? { node: c, out: 'out' } : { node: c.slice(0, i), out: c.slice(i + 9) };
};

// ---- colour helpers (MaterialX semantics, all channels 0..1) -----------------
function rgb2hsv([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}
function hsv2rgb([h, s, v]) {
  h = ((h % 1) + 1) % 1;
  s = clamp01(s);
  v = clamp01(v);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
function broadcast(fn, a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(a[a.length === 1 ? 0 : i], b[b.length === 1 ? 0 : i]);
  return out;
}
const mixVec = (bg, fg, m) => broadcast((x, y) => x + (y - x) * m, bg, fg);

// ---- graph compilation ---------------------------------------------------------
// Expressions: {k:'c', v} constant · {k:'img', img, chan} image sample ·
// {k:'op', fn, args} node. Each gets an id for per-pixel memoisation.
function makeCompiler(specs, ctx) {
  const memo = new Map();
  let nextId = 0;
  const tag = (e) => ((e.id = nextId++), e);

  function compile(nodePath, outName) {
    const key = `${nodePath}#${outName}`;
    if (memo.has(key)) return memo.get(key);
    const id = String(specs[`${nodePath}.info:id`]?.fields?.default || '');
    const base = id.replace(/^ND_/, '');
    const input = (name, def) => {
      const f = specs[`${nodePath}.inputs:${name}`]?.fields;
      if (f?.connectionPaths?.length) {
        const c = parseConn(f.connectionPaths[0]);
        return compile(c.node, c.out);
      }
      if (f && f.default !== undefined && f.default !== null) return tag({ k: 'c', v: toVec(f.default) });
      return tag({ k: 'c', v: toVec(def) });
    };
    const binary = (fn, d1, d2) => tag({ k: 'op', fn: (a, b) => broadcast(fn, a, b), args: [input('in1', d1), input('in2', d2)] });

    let expr;
    if (/^image_/.test(base) || id === 'UsdUVTexture') {
      const file = specs[`${nodePath}.inputs:file`]?.fields?.default;
      const fname = typeof file === 'string' ? file : file?.path;
      if (!fname) throw new Error(`image node ${nodePath} has no file`);
      const chan = { r: 0, g: 1, b: 2, a: 3 }[outName];
      const isFloat = /_float$/.test(base);
      expr = tag({ k: 'img', img: ctx.register(fname), chan: chan !== undefined ? chan : isFloat ? 0 : null });
    } else if (/^rgbtohsv/.test(base)) expr = tag({ k: 'op', fn: rgb2hsv, args: [input('in', [0, 0, 0])] });
    else if (/^hsvtorgb/.test(base)) expr = tag({ k: 'op', fn: hsv2rgb, args: [input('in', [0, 0, 0])] });
    else if (/^separate[234]/.test(base)) {
      const ch = { outr: 0, outg: 1, outb: 2, outa: 3, outx: 0, outy: 1, outz: 2, outw: 3 }[outName] ?? 0;
      expr = tag({ k: 'op', fn: (a) => [a[Math.min(ch, a.length - 1)]], args: [input('in', [0, 0, 0])] });
    } else if (/^combine2/.test(base)) expr = tag({ k: 'op', fn: (a, b) => [a[0], b[0]], args: [input('in1', 0), input('in2', 0)] });
    else if (/^combine3/.test(base)) expr = tag({ k: 'op', fn: (a, b, c) => [a[0], b[0], c[0]], args: [input('in1', 0), input('in2', 0), input('in3', 0)] });
    else if (/^add_/.test(base)) expr = binary((a, b) => a + b, 0, 0);
    else if (/^subtract_/.test(base)) expr = binary((a, b) => a - b, 0, 0);
    else if (/^multiply_/.test(base)) expr = binary((a, b) => a * b, 1, 1);
    else if (/^divide_/.test(base)) expr = binary((a, b) => (b !== 0 ? a / b : 0), 1, 1);
    else if (/^(min|max)_/.test(base)) expr = binary(base.startsWith('min') ? Math.min : Math.max, 0, 0);
    else if (/^power_/.test(base)) expr = binary((a, b) => Math.pow(Math.max(a, 0), b), 1, 1);
    else if (/^mix_/.test(base)) expr = tag({ k: 'op', fn: (bg, fg, m) => mixVec(bg, fg, m[0]), args: [input('bg', 0), input('fg', 0), input('mix', 0)] });
    else if (/^clamp_/.test(base)) expr = tag({ k: 'op', fn: (a, lo, hi) => broadcast((x, l) => Math.max(x, l), broadcast(Math.min, a, hi), lo), args: [input('in', 0), input('low', 0), input('high', 1)] });
    else if (/^invert_/.test(base)) expr = tag({ k: 'op', fn: (a, amt) => broadcast((x, m) => m - x, a, amt), args: [input('in', 0), input('amount', 1)] });
    else if (/^(dot_|convert_|swizzle_|normalmap)/.test(base)) expr = input('in', [0, 0, 0]);
    else if (/^constant_/.test(base)) expr = input('value', 0);
    else if (/^luminance_/.test(base)) expr = tag({ k: 'op', fn: (a) => [0.2126 * a[0] + 0.7152 * (a[1] ?? a[0]) + 0.0722 * (a[2] ?? a[0])], args: [input('in', [0, 0, 0])] });
    else if (/^saturate_/.test(base)) expr = tag({ k: 'op', fn: (a) => a.map(clamp01), args: [input('in', [0, 0, 0])] });
    // RealityKit-only nodes: these sample the real environment / camera
    // background on Apple devices. Approximate with neutral values and say so.
    else if (base === 'realitykit_environment_radiance') {
      ctx.note('environment radiance approximated as base colour × ambient');
      expr = outName === 'specularRadiance'
        ? tag({ k: 'c', v: [0.03, 0.03, 0.03] })
        : tag({ k: 'op', fn: (c) => c.map((x) => x * 0.55), args: [input('baseColor', [1, 1, 1])] });
    } else if (base === 'realitykit_background_blur_color3') {
      ctx.note('camera-background blur approximated as neutral grey');
      expr = tag({ k: 'c', v: [0.45, 0.45, 0.45] });
    } else throw new Error(`Unsupported MaterialX node ${id || '(untyped)'} at ${nodePath}`);
    memo.set(key, expr);
    return expr;
  }
  return compile;
}

// First image node upstream of a node (used for normal maps, which three
// decodes itself — the ×2−1 math in the graph must not be baked).
function firstUpstreamImage(specs, nodePath, seen = new Set()) {
  if (seen.has(nodePath)) return null;
  seen.add(nodePath);
  const id = String(specs[`${nodePath}.info:id`]?.fields?.default || '');
  if (/^ND_image_/.test(id) || id === 'UsdUVTexture') {
    const file = specs[`${nodePath}.inputs:file`]?.fields?.default;
    return typeof file === 'string' ? file : file?.path || null;
  }
  const prefix = `${nodePath}.inputs:`;
  for (const k in specs) {
    if (!k.startsWith(prefix)) continue;
    const c = specs[k]?.fields?.connectionPaths?.[0];
    if (!c) continue;
    const found = firstUpstreamImage(specs, parseConn(c).node, seen);
    if (found) return found;
  }
  return null;
}

// ---- images --------------------------------------------------------------------
function findAsset(assets, fname, basePath) {
  if (assets[fname]) return assets[fname];
  const joined = basePath ? `${basePath}/${fname}` : fname;
  if (assets[joined]) return assets[joined];
  const clean = fname.replace(/^\.\//, '');
  const key = Object.keys(assets).find((k) => k === clean || k.endsWith('/' + clean));
  return key ? assets[key] : null;
}

async function decodeToPixels(bytes, w, h) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return g.getImageData(0, 0, w, h).data;
}

async function bitmapSize(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  const s = { w: bmp.width, h: bmp.height };
  bmp.close?.();
  return s;
}

// ---- evaluation / baking ---------------------------------------------------------
function makeEvaluator(ctx) {
  const cacheVal = [];
  const cacheStamp = [];
  let stamp = 0;
  function ev(e, px) {
    if (cacheStamp[e.id] === stamp) return cacheVal[e.id];
    let v;
    if (e.k === 'c') v = e.v;
    else if (e.k === 'img') {
      const d = ctx.pixels[e.img];
      const i = px * 4;
      v = e.chan === null ? [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255] : [d[i + e.chan] / 255];
    } else v = e.fn(...e.args.map((a) => ev(a, px)));
    cacheStamp[e.id] = stamp;
    cacheVal[e.id] = v;
    return v;
  }
  return (e, px) => {
    stamp++;
    return ev(e, px);
  };
}

async function bakeExpr(expr, ctx, channels, onStatus) {
  const { width: W, height: H } = ctx;
  const out = new ImageData(W, H);
  const d = out.data;
  const evaluate = makeEvaluator(ctx);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = y * W + x;
      const v = evaluate(expr, px);
      const i = px * 4;
      if (channels === 1) {
        d[i] = d[i + 1] = d[i + 2] = clamp01(v[0]) * 255;
      } else {
        d[i] = clamp01(v[0]) * 255;
        d[i + 1] = clamp01(v[1] ?? v[0]) * 255;
        d[i + 2] = clamp01(v[2] ?? v[0]) * 255;
      }
      d[i + 3] = 255;
    }
    if ((y & 63) === 63) {
      onStatus?.(`Baking MaterialX texture… ${Math.round(((y + 1) / H) * 100)}%`);
      await new Promise((r) => setTimeout(r)); // keep the UI responsive
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas;
}

function makeTexture(canvas, srgb, like) {
  const t = new CanvasTexture(canvas);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  if (like) {
    t.flipY = like.flipY;
    t.wrapS = like.wrapS;
    t.wrapT = like.wrapT;
    t.repeat.copy(like.repeat);
    t.offset.copy(like.offset);
  }
  t.needsUpdate = true;
  return t;
}

function anyTexture(material) {
  for (const k in material) if (material[k] && material[k].isTexture) return material[k];
  return null;
}

/**
 * Bake MaterialX-driven surface inputs for every mesh in `group` whose bound
 * material the composer left untextured. Returns the number of maps applied.
 */
export async function applyMaterialXFallbacks(group, specs, assets, selections, basePath = '', onStatus) {
  const result = { applied: 0, notes: [] };
  if (!specs || !group) return result;
  const bindings = resolveBindings(specs, selections);
  if (!bindings.size) return result;
  const selKey = JSON.stringify(selections);
  let applied = 0;
  const notes = new Set();
  const done = new Set(); // material objects already processed

  const meshes = [];
  group.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });

  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const matPath = materialPathFor(mesh, bindings);
    if (!matPath) continue;
    const surface = findSurfaceShader(specs, matPath);
    if (!surface) continue;
    const matName = matPath.slice(matPath.lastIndexOf('/') + 1);

    // Which shader node feeds each slot. Unlit RealityKit surfaces carry only a
    // colour; their normal/roughness live on the environment-radiance node.
    const feeds = Object.entries(surface.inputs).map(([inputName, slotName]) => ({ shader: surface.path, inputName, slot: SLOTS[slotName] }));
    if (surface.unlit) {
      const rad = findShaderNodes(specs, matPath).find((n) => n.id.includes('realitykit_environment_radiance'));
      if (rad) feeds.push({ shader: rad.path, inputName: 'normal', slot: SLOTS.normal }, { shader: rad.path, inputName: 'roughness', slot: SLOTS.roughness });
      notes.add(`"${matName}" is a RealityKit unlit material — shown lit, as an approximation`);
    }

    for (const material of mats) {
      if (!material || done.has(material)) continue;
      done.add(material);

      for (const { shader, inputName, slot } of feeds) {
        const input = inputName;
        if (material[slot.prop]) continue; // the composer already resolved it
        const conn = specs[`${shader}.inputs:${input}`]?.fields?.connectionPaths?.[0];
        if (!conn) continue;
        const { node, out } = parseConn(conn);
        const srcId = String(specs[`${node}.info:id`]?.fields?.default || '');
        if (srcId === 'UsdUVTexture') continue; // composer territory; nothing we can add

        const key = `${selKey}|${matPath}|${input}`;
        try {
          let canvas = cache.get(key);
          if (!canvas) {
            if (slot.imageOnly) {
              const file = firstUpstreamImage(specs, node);
              const bytes = file && findAsset(assets, file, basePath);
              if (!bytes) continue;
              const { w, h } = await bitmapSize(bytes);
              const s = Math.min(1, MAX_BAKE / Math.max(w, h));
              const W = Math.max(1, Math.round(w * s));
              const H = Math.max(1, Math.round(h * s));
              const px = await decodeToPixels(bytes, W, H);
              canvas = document.createElement('canvas');
              canvas.width = W;
              canvas.height = H;
              canvas.getContext('2d').putImageData(new ImageData(px, W, H), 0, 0);
            } else {
              // Compile the graph, decode every referenced image at a common
              // resolution, then evaluate per pixel.
              const files = [];
              const ctx = {
                register: (fname) => {
                  let i = files.indexOf(fname);
                  if (i < 0) i = files.push(fname) - 1;
                  return i;
                },
                note: (text) => notes.add(`"${matName}": ${text}`),
                pixels: [],
                width: 0,
                height: 0,
              };
              const expr = makeCompiler(specs, ctx)(node, out);
              if (expr.k === 'img') {
                // Plain image (possibly one channel): no per-pixel evaluation needed —
                // three samples the right channel of the map itself.
                const bytes = findAsset(assets, files[expr.img], basePath);
                if (!bytes) throw new Error(`missing texture ${files[expr.img]}`);
                const { w, h } = await bitmapSize(bytes);
                const sc = Math.min(1, MAX_BAKE / Math.max(w, h));
                const W = Math.max(1, Math.round(w * sc));
                const H = Math.max(1, Math.round(h * sc));
                canvas = document.createElement('canvas');
                canvas.width = W;
                canvas.height = H;
                canvas.getContext('2d').putImageData(new ImageData(await decodeToPixels(bytes, W, H), W, H), 0, 0);
                cache.set(key, canvas);
                material[slot.prop] = makeTexture(canvas, slot.srgb, anyTexture(material));
                if (slot.scalar) material[slot.scalar] = 1;
                material.needsUpdate = true;
                applied++;
                continue;
              }
              if (files.length === 0) {
                // Pure constant graph: evaluate once and set the scalar/colour.
                const v = makeEvaluator(ctx)(expr, 0);
                if (slot.scalar) material[slot.scalar] = clamp01(v[0]);
                else if (slot.prop === 'map') material.color.setRGB(clamp01(v[0]), clamp01(v[1] ?? v[0]), clamp01(v[2] ?? v[0]), SRGBColorSpace);
                material.needsUpdate = true;
                applied++;
                continue;
              }
              onStatus?.('Decoding MaterialX textures…');
              const byteList = files.map((f) => findAsset(assets, f, basePath));
              if (byteList.some((b) => !b)) throw new Error(`missing texture(s) ${files.filter((f, i) => !byteList[i]).join(', ')}`);
              const sizes = await Promise.all(byteList.map(bitmapSize));
              const maxW = Math.max(...sizes.map((s) => s.w));
              const maxH = Math.max(...sizes.map((s) => s.h));
              const s = Math.min(1, MAX_BAKE / Math.max(maxW, maxH));
              ctx.width = Math.max(1, Math.round(maxW * s));
              ctx.height = Math.max(1, Math.round(maxH * s));
              ctx.pixels = await Promise.all(byteList.map((b) => decodeToPixels(b, ctx.width, ctx.height)));
              canvas = await bakeExpr(expr, ctx, slot.channels, onStatus);
            }
            cache.set(key, canvas);
          }
          material[slot.prop] = makeTexture(canvas, slot.srgb, anyTexture(material));
          if (slot.scalar) material[slot.scalar] = 1; // let the map carry the value
          if (slot.prop === 'map') material.color.setRGB(1, 1, 1);
          material.needsUpdate = true;
          applied++;
        } catch (e) {
          console.warn(`MaterialX fallback skipped for ${matPath} (${input}):`, e.message);
          notes.add(`"${matName}" (${input}): ${e.message}`);
        }
      }
    }
  }
  result.applied = applied;
  result.notes = [...notes];
  return result;
}
