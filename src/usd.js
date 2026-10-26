// USD parsing: mirrors three's USDLoader.parse() using the same parsers and
// composer, but exposes the composer's variant-selection argument, enumerates
// the file's variant sets and patches material-binding strength.
// No renderer/DOM access (textures resolve lazily through the composer).
import { DefaultLoadingManager } from 'three';
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { USDComposer } from 'three/addons/loaders/usd/USDComposer.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { extOf, formatSize } from './utils.js';
import { USDZ_LIMITS } from './config.js';

const CRATE_MAGIC = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]; // "PXR-USDC"
const LAYER_EXT = new Set(['usd', 'usda', 'usdc']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'avif']);

/** Property-path suffix of a material binding relationship. */
export const MATERIAL_BINDING_REL = '.material:binding';

/** True if the bytes start with the binary USD crate magic ("PXR-USDC"). */
export const isCrate = (u8) => u8.byteLength >= 8 && CRATE_MAGIC.every((b, i) => u8[i] === b);

/** True if the bytes start with a zip local-file header ("PK"). */
export const isZip = (u8) => u8.byteLength >= 2 && u8[0] === 0x50 && u8[1] === 0x4b;

/** An ArrayBuffer holding exactly the bytes of `u8` (copies only if it is a view). */
export const asArrayBuffer = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));

/** Remove variant-selection segments ("/{set=option}") from a spec path. */
export const stripVariantSegments = (p) => p.replace(/\/\{[^}]*\}/g, '');

/**
 * Variant sets: a prim lists its sets in fields.variantSetChildren, the options
 * live on "<prim>/{set=}" (fields.variantChildren) and the file's own choice in
 * fields.variantSelection. Selections are global per set name (as the composer
 * applies them), so identically named sets on several prims switch together.
 * Only sets with more than one option are returned.
 *
 * @returns {{ name: string, options: string[], selected: string|null }[]}
 */
export function enumerateVariants(parsed) {
  const specs = parsed?.specsByPath || {};
  const sets = new Map();
  for (const path in specs) {
    const f = specs[path]?.fields;
    if (!f?.variantSetChildren) continue;
    for (const setName of f.variantSetChildren) {
      const entry = sets.get(setName) || { name: setName, options: new Set(), selected: null };
      for (const o of specs[`${path}/{${setName}=}`]?.fields?.variantChildren || []) entry.options.add(o);
      if (!entry.selected && f.variantSelection?.[setName]) entry.selected = f.variantSelection[setName];
      sets.set(setName, entry);
    }
  }
  return [...sets.values()]
    .map((s) => {
      const options = [...s.options];
      return { name: s.name, options, selected: s.selected || options[0] || null };
    })
    .filter((s) => s.options.length > 1);
}

/**
 * USD material-binding strength: a binding authored on an ancestor prim with
 * bindMaterialAs = "strongerThanDescendants" overrides the bindings of every
 * mesh below it. three's composer resolves each mesh's own binding only, so
 * variants that switch materials this way (a common exporter pattern) would
 * fall back to placeholder materials. Propagate such bindings down to the Mesh
 * descendants in the spec table (mutates `specs`) before composing.
 */
export function propagateStrongBindings(specs) {
  if (!specs) return;
  const REL = MATERIAL_BINDING_REL;
  const strong = [];
  for (const k in specs) {
    if (!k.endsWith(REL)) continue;
    const fields = specs[k]?.fields;
    if (fields?.bindMaterialAs === 'strongerThanDescendants' && fields.targetPaths?.length) {
      strong.push({ prim: k.slice(0, -REL.length), spec: specs[k] });
    }
  }
  if (!strong.length) return;
  strong.sort((a, b) => b.prim.length - a.prim.length); // deepest ancestor wins
  const isPrimKey = (k) => !k.slice(k.lastIndexOf('/')).includes('.');
  const isMesh = (k) => specs[k]?.fields?.typeName === 'Mesh' || specs[stripVariantSegments(k)]?.fields?.typeName === 'Mesh';
  for (const k of Object.keys(specs)) {
    if (!isPrimKey(k)) continue;
    const anc = strong.find((a) => k.startsWith(a.prim + '/'));
    if (!anc || !isMesh(k)) continue;
    specs[k + REL] = { ...anc.spec, fields: { ...anc.spec.fields, bindMaterialAs: 'weakerThanDescendants' } };
    const props = specs[k].fields?.properties;
    if (Array.isArray(props) && !props.includes('material:binding')) specs[k].fields.properties = [...props, 'material:binding'];
  }
}

/**
 * Zip-bomb protection for USDZ archives. Returns an fflate `filter` callback
 * that enforces the limits from the central directory *before* anything is
 * inflated, and skips entries the viewer never reads so they are not
 * decompressed at all. `first` records the archive's first entry (the USDZ root
 * layer by spec), independent of which entries were skipped.
 */
export function makeZipGuard({ maxEntries, maxEntryBytes, maxTotalBytes }) {
  let entries = 0;
  let total = 0;
  const guard = {
    first: null,
    filter(file) {
      if (++entries > maxEntries) throw new Error(`USDZ archive has too many entries (limit ${maxEntries})`);
      guard.first ??= file.name;
      const ext = extOf(file.name);
      if (!LAYER_EXT.has(ext) && !IMAGE_EXT.has(ext)) return false;
      if (file.originalSize > maxEntryBytes) {
        throw new Error(`USDZ entry "${file.name}" is too large (${formatSize(file.originalSize)}; limit ${formatSize(maxEntryBytes)})`);
      }
      total += file.originalSize;
      if (total > maxTotalBytes) throw new Error(`USDZ archive is too large once unpacked (limit ${formatSize(maxTotalBytes)})`);
      return true;
    },
  };
  return guard;
}

/**
 * Parse a USD / USDA / USDC / USDZ buffer into its root layer plus, for USDZ,
 * the packaged sub-layers and raw image bytes.
 */
export function parseLayers(buffer) {
  const usda = new USDAParser();
  const usdc = new USDCParser();
  const decoder = new TextDecoder();
  const bytes = new Uint8Array(buffer);
  const assets = {};
  let basePath = '';
  let data;

  if (isCrate(bytes)) {
    data = usdc.parseData(buffer);
  } else if (isZip(bytes)) {
    const guard = makeZipGuard(USDZ_LIMITS);
    const zip = unzipSync(bytes, { filter: guard.filter });
    const names = Object.keys(zip);
    if (!guard.first) throw new Error('Empty USDZ archive');
    for (const name of names) {
      const ext = extOf(name);
      const fileBytes = zip[name];
      if (IMAGE_EXT.has(ext)) {
        assets[name] = fileBytes; // raw image bytes; the composer creates object URLs lazily
      } else if (LAYER_EXT.has(ext)) {
        assets[name] = isCrate(fileBytes) ? usdc.parseData(asArrayBuffer(fileBytes)) : usda.parseData(decoder.decode(fileBytes));
      }
    }
    const first = guard.first; // per the USDZ spec the first entry is the root layer
    const slash = first.lastIndexOf('/');
    basePath = slash >= 0 ? first.slice(0, slash) : '';
    // An image entry is truthy too, so check the type rather than presence.
    data = LAYER_EXT.has(extOf(first)) ? assets[first] : null;
    if (!data) throw new Error(`Invalid USDZ package: the first entry ("${first}") must be a USD layer.`);
  } else {
    data = usda.parseData(decoder.decode(bytes));
  }
  return { data, assets, basePath };
}

/**
 * Synchronously compose a USD buffer into a three.js Group.
 * Textures load asynchronously; await `ready` before relying on them.
 */
export function composeUSD(buffer, variantSelections = {}) {
  const { data, assets, basePath } = parseLayers(buffer);
  propagateStrongBindings(data?.specsByPath);
  const composer = new USDComposer(DefaultLoadingManager);
  const group = composer.compose(data, assets, variantSelections, basePath);
  return {
    group,
    variants: enumerateVariants(data),
    ready: Promise.all(composer.texturePromises || []),
    data,
    assets,
    basePath,
  };
}
