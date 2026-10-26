// Pure helpers (no DOM, no three.js) — unit-tested in test/utils.test.js.

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const deg2rad = (d) => (d * Math.PI) / 180;

/** Decimal places to display for a slider step (robust to 1e-6 style steps). */
export function stepDecimals(step) {
  if (!(step > 0)) return 0;
  return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 6);
}

export const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Keys that would reach Object.prototype through an ordinary assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively copy `patch` into `target` (in place) and return `target`.
 * Nested objects are merged; arrays and primitives are replaced. Prototype-
 * polluting keys are ignored. Use for trusted patches (presets, defaults).
 */
export function deepMerge(target, patch) {
  if (!isPlainObject(patch)) return target;
  for (const k of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (isPlainObject(patch[k]) && isPlainObject(target[k])) deepMerge(target[k], patch[k]);
    else target[k] = patch[k];
  }
  return target;
}

/**
 * Merge an untrusted `patch` (e.g. JSON from localStorage) into `target`, in
 * place: only keys that already exist in `target` are taken, and only when the
 * value has the same type (plain objects recurse). Anything else is dropped,
 * so stale, tampered or malformed data can never introduce new properties or
 * change a value's type.
 */
export function mergeKnown(target, patch) {
  if (!isPlainObject(patch)) return target;
  for (const k of Object.keys(target)) {
    if (UNSAFE_KEYS.has(k) || !Object.hasOwn(patch, k)) continue;
    const cur = target[k];
    const val = patch[k];
    if (isPlainObject(cur)) {
      if (isPlainObject(val)) mergeKnown(cur, val);
    } else if (typeof val === typeof cur && !isPlainObject(val) && !Array.isArray(val) && (typeof val !== 'number' || Number.isFinite(val))) {
      target[k] = val;
    }
  }
  return target;
}

/** True for a well-formed /api/models entry pointing at a same-origin model URL. */
export function isValidModelEntry(m) {
  return (
    isPlainObject(m) &&
    typeof m.name === 'string' &&
    m.name.length > 0 &&
    typeof m.url === 'string' &&
    m.url.startsWith('/models/') &&
    typeof m.extension === 'string' &&
    Number.isFinite(m.size) &&
    m.size >= 0 &&
    typeof m.modified === 'string'
  );
}

/** Accent/case-insensitive text for search ("kucuk" matches "Küçük"). */
export const foldText = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Loose name match used to pair animation clips with variant options:
 * equal, or one contains the other, ignoring case and accents.
 */
export function namesMatch(a, b) {
  if (!a || !b) return false;
  const x = foldText(a);
  const y = foldText(b);
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Lowercase extension of a file name or archive path, without the dot.
 * Returns '' when there is none ("noext", "dir.v2/file", ".hidden").
 */
export function extOf(name) {
  const s = String(name);
  const dot = s.lastIndexOf('.');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return dot <= slash + 1 ? '' : s.slice(dot + 1).toLowerCase();
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const formatTime = (t) => `${t.toFixed(1)} s`;

/** " 42%" for a lengthComputable ProgressEvent, '' otherwise. */
export const formatPct = (e) => (e?.lengthComputable && e.total > 0 ? ` ${Math.round((e.loaded / e.total) * 100)}%` : '');

/** Short relative time ("5 min ago", "3 d ago"), falling back to a date. */
export function relTime(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Turn loader errors into something a user can act on. */
export function describeLoadError(err, name) {
  const msg = String(err?.message || err || 'unknown error');
  if (/\b404\b|not found/i.test(msg)) return `"${name}" was not found on the server — it may have been removed. Refresh the model list.`;
  if (/\b5\d\d\b/.test(msg)) return `The server failed while sending "${name}" (${msg}).`;
  if (/failed to fetch|network|load failed|aborted/i.test(msg)) return `Network error while downloading "${name}". Check the connection and try again.`;
  if (/zip|usdz|crate|parse|unexpected|invalid|malformed|token/i.test(msg)) {
    return `"${name}" could not be parsed — it may be corrupted or use USD features this viewer does not support. (${msg})`;
  }
  return `Failed to load "${name}". (${msg})`;
}

/** The `material` of a mesh as an array (meshes may carry one or many). */
export const materialsOf = (obj) => (Array.isArray(obj.material) ? obj.material : [obj.material]).filter(Boolean);

/** Every texture referenced by a material's properties. */
export function texturesOf(material) {
  const out = [];
  for (const k in material) {
    const v = material[k];
    if (v && v.isTexture) out.push(v);
  }
  return out;
}
