import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Color,
  Group,
  Box3,
  Sphere,
  Vector3,
  Quaternion,
  HemisphereLight,
  DirectionalLight,
  PointLight,
  PlaneGeometry,
  RingGeometry,
  ShadowMaterial,
  MeshBasicMaterial,
  Mesh,
  PMREMGenerator,
  SRGBColorSpace,
  NoToneMapping,
  NeutralToneMapping,
  ACESFilmicToneMapping,
  AgXToneMapping,
  PCFShadowMap,
  ColorManagement,
  AnimationMixer,
  FileLoader,
  DefaultLoadingManager,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { USDAParser } from 'three/addons/loaders/usd/USDAParser.js';
import { USDCParser } from 'three/addons/loaders/usd/USDCParser.js';
import { USDComposer } from 'three/addons/loaders/usd/USDComposer.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import qrcode from 'qrcode-generator';
import { applyMaterialXFallbacks, clearMaterialXCache } from './mtlx.js';

import './style.css';

// ===========================================================================
// Constants & defaults
// ===========================================================================
const STORAGE_KEY = 'usdz-viewer.settings.v1';
const SECTIONS_KEY = 'usdz-viewer.sections.v1';
const MODEL_EXTENSIONS = ['usd', 'usda', 'usdc', 'usdz'];
// Deep link: /?model=<filename> opens that model directly (see fetchModels).
const linkedModel = new URLSearchParams(location.search).get('model');

// Gallery view state (grid/list, sort, format filter) — persisted separately
// from the render settings so "Reset all" leaves it alone.
const GALLERY_KEY = 'usdz-viewer.gallery.v1';
const gallery = { view: 'grid', sort: 'name', dir: 'asc', format: 'all' };
try {
  Object.assign(gallery, JSON.parse(localStorage.getItem(GALLERY_KEY) || '{}'));
} catch (e) {
  /* ignore */
}
function saveGallery() {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(gallery));
  } catch (e) {
    /* ignore */
  }
}

const TONE_MAPPING = {
  none: { label: 'None', value: NoToneMapping },
  neutral: { label: 'Neutral', value: NeutralToneMapping },
  aces: { label: 'ACES Filmic', value: ACESFilmicToneMapping },
  agx: { label: 'AgX', value: AgXToneMapping },
};

const SHADOW_QUALITY = {
  low: { label: 'Low', size: 512 },
  medium: { label: 'Medium', size: 1024 },
  high: { label: 'High', size: 2048 },
};

// Performance preset controls render resolution (device-pixel-ratio cap).
const PERF_QUALITY = {
  low: { label: 'Low', pixelRatio: 1.0 },
  medium: { label: 'Medium', pixelRatio: 1.5 },
  high: { label: 'High', pixelRatio: 2.0 },
};

// AR lighting modes scale the viewer lights while in passthrough AR.
const AR_LIGHTING = {
  auto: { label: 'Auto', ambient: 1.0, key: 1.0 },
  soft: { label: 'Soft', ambient: 1.4, key: 0.6 },
  neutral: { label: 'Neutral', ambient: 1.0, key: 1.0 },
  strong: { label: 'Strong', ambient: 0.7, key: 1.6 },
};

// Quest-friendly defaults: one shadow-casting key light, fill/point off,
// medium shadow map. `preset` is informational ('default' | 'custom' | name).
const DEFAULT_SETTINGS = {
  preset: 'default',
  env: { background: '#12151c', exposure: 1.0, toneMapping: 'neutral', envIntensity: 1.0 },
  ambient: { enabled: true, intensity: 0.6, sky: '#bfd3ff', ground: '#20242c' },
  key: { enabled: true, intensity: 2.4, x: 3, y: 5, z: 2, color: '#ffffff' },
  fill: { enabled: false, intensity: 0.7, x: -4, y: 2, z: 3, color: '#ffffff' },
  point: { enabled: false, intensity: 8, x: 0, y: 3, z: 0, distance: 0, decay: 2, color: '#ffffff' },
  shadow: { enabled: true, quality: 'medium', bias: -0.0005, normalBias: 0.02 },
  ground: { enabled: true, opacity: 0.5, size: 8, color: '#000000', receive: true },
  transform: { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, scale: 1 },
  performance: { quality: 'medium' },
  ar: { lighting: 'auto' },
};

const DEFAULT_TRANSFORM = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, scale: 1 };

// Lighting presets patch the relevant subsections and are applied instantly.
const LIGHTING_PRESETS = {
  studio: {
    ambient: { enabled: true, intensity: 0.5 },
    key: { enabled: true, intensity: 2.4, x: 3, y: 5, z: 2 },
    fill: { enabled: true, intensity: 0.7, x: -4, y: 2, z: 3 },
    point: { enabled: false },
    shadow: { enabled: true, quality: 'medium' },
    env: { background: '#14181f', envIntensity: 1.0 },
  },
  outdoor: {
    ambient: { enabled: true, intensity: 0.95 },
    key: { enabled: true, intensity: 3.0, x: 5, y: 8, z: 3 },
    fill: { enabled: false },
    point: { enabled: false },
    shadow: { enabled: true, quality: 'high' },
    env: { background: '#233447', envIntensity: 1.2 },
  },
  soft: {
    ambient: { enabled: true, intensity: 1.25 },
    key: { enabled: true, intensity: 1.2, x: 2, y: 4, z: 3 },
    fill: { enabled: true, intensity: 0.5 },
    point: { enabled: false },
    shadow: { enabled: true, quality: 'medium' },
    env: { background: '#1b1e26', envIntensity: 1.1 },
  },
  flat: {
    ambient: { enabled: true, intensity: 1.8 },
    key: { enabled: false },
    fill: { enabled: false },
    point: { enabled: false },
    shadow: { enabled: false },
    env: { background: '#151821', envIntensity: 0.8 },
  },
};

// ===========================================================================
// Tiny utilities
// ===========================================================================
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const deg2rad = (d) => (d * Math.PI) / 180;

// Decimal places to display for a slider step (robust to 1e-6 style steps).
function stepDecimals(step) {
  if (!(step > 0)) return 0;
  return clamp(Math.ceil(-Math.log10(step) - 1e-9), 0, 6);
}

function isObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x);
}
function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    if (isObject(patch[k]) && isObject(target[k])) deepMerge(target[k], patch[k]);
    else target[k] = patch[k];
  }
  return target;
}

// Accent/case-insensitive text for search ("kucuk" matches "Küçük").
const foldText = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const extOf = (name) => String(name).split('.').pop().toLowerCase();
const isTypingTarget = (e) => !!e.target?.closest?.('input, select, textarea, [contenteditable]');

// ===========================================================================
// Settings state + persistence
// ===========================================================================
// NOTE: `settings` (and its sub-objects) must only ever be mutated in place —
// the control closures hold references to the sub-objects.
let settings = structuredClone(DEFAULT_SETTINGS);
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) settings = deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
} catch (e) {
  console.warn('Could not read saved settings:', e);
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    /* storage may be unavailable (private mode) — non-fatal */
  }
}

// ===========================================================================
// Renderer / scene / camera / controls
// ===========================================================================
ColorManagement.enabled = true;

const canvasHolder = $('#canvas-holder');

const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap; // PCFSoftShadowMap was removed in three r186
renderer.xr.enabled = true;
// updateStyle=false: never write inline width/height on the canvas — CSS keeps
// it at 100% of its holder, so it can never overflow with a stale inline size.
renderer.setSize(canvasHolder.clientWidth, canvasHolder.clientHeight, false);
canvasHolder.appendChild(renderer.domElement);

// Render-on-demand bookkeeping (see render()): the scene is only drawn while
// `framesToRender` > 0. Anything that changes what's on screen calls
// invalidate(); a few frames are requested so damping and shadow-map updates
// settle. Starts non-zero so the first paint happens.
let framesToRender = 3;
function invalidate(frames = 3) {
  if (frames > framesToRender) framesToRender = frames;
}

const scene = new Scene();

const camera = new PerspectiveCamera(50, canvasHolder.clientWidth / canvasHolder.clientHeight, 0.01, 1000);
camera.position.set(2.5, 1.8, 2.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.5, 0);
controls.update();

// Lightweight, generated IBL (no external HDR download). The generator's GPU
// resources are released once the environment texture exists.
RectAreaLightUniformsLib.init();
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

// ---- Model hierarchy -------------------------------------------------------
// modelContainer carries the *user* transform (and AR placement). The loaded
// USD group is normalized inside it (centered on XZ, base at y=0).
const modelContainer = new Group();
scene.add(modelContainer);
let currentInner = null; // the loaded USD Group
let modelHalfHeight = 0.5;
let modelRadius = 1; // bounding-sphere radius of the *unscaled* model
const modelSize = new Vector3(); // unscaled W × H × D in metres

// Lights, ground and the shadow frustum scale with the model so that a 2 cm
// figurine and a 20 m building both get a sensible rig.
const modelScaleFactor = () => Math.max(modelRadius * Math.max(modelContainer.scale.x, 0.01), 0.25);
const lightRigScale = () => Math.max(modelScaleFactor(), 1);

// ---- Viewer lights ---------------------------------------------------------
const hemi = new HemisphereLight(0xbfd3ff, 0x20242c, 0.6);
scene.add(hemi);

const keyLight = new DirectionalLight(0xffffff, 2.4);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.bias = -0.0005;
keyLight.shadow.normalBias = 0.02;
scene.add(keyLight);
scene.add(keyLight.target);

const fillLight = new DirectionalLight(0xffffff, 0.7);
scene.add(fillLight);
scene.add(fillLight.target);

const pointLight = new PointLight(0xffffff, 8, 0, 2);
scene.add(pointLight);

// ---- Ground (contact-shadow catcher) --------------------------------------
const groundMat = new ShadowMaterial({ opacity: 0.5 });
groundMat.color = new Color(0x000000);
const groundMesh = new Mesh(new PlaneGeometry(1, 1), groundMat);
groundMesh.rotation.x = -Math.PI / 2;
groundMesh.receiveShadow = true;
scene.add(groundMesh);

// ---- AR reticle ------------------------------------------------------------
const reticle = new Mesh(
  new RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
  new MeshBasicMaterial({ color: 0x4c8dff })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ===========================================================================
// Apply functions — push `settings` into the scene
// ===========================================================================
const _bgColor = new Color();
function applyEnvironment() {
  if (!ar.active) scene.background = _bgColor.set(settings.env.background);
  renderer.toneMapping = (TONE_MAPPING[settings.env.toneMapping] || TONE_MAPPING.neutral).value;
  renderer.toneMappingExposure = settings.env.exposure;
  scene.environmentIntensity = settings.env.envIntensity;
  invalidate();
}

function applyLighting() {
  hemi.visible = settings.ambient.enabled;
  hemi.intensity = settings.ambient.intensity;
  hemi.color.set(settings.ambient.sky);
  hemi.groundColor.set(settings.ambient.ground);

  keyLight.visible = settings.key.enabled;
  keyLight.intensity = settings.key.intensity;
  keyLight.color.set(settings.key.color);

  fillLight.visible = settings.fill.enabled;
  fillLight.intensity = settings.fill.intensity;
  fillLight.color.set(settings.fill.color);

  pointLight.visible = settings.point.enabled;
  pointLight.intensity = settings.point.intensity;
  pointLight.color.set(settings.point.color);
  pointLight.position.set(settings.point.x, settings.point.y, settings.point.z);
  pointLight.distance = settings.point.distance;
  pointLight.decay = settings.point.decay;

  updateLightRig();
  if (ar.active) applyARLighting();
  invalidate();
}

// Directional lights are positioned relative to the model's size and aimed at
// its center, so the shadow camera always sits outside the model.
function updateLightRig() {
  const c = modelContainer.position;
  const s = lightRigScale();
  keyLight.position.set(settings.key.x * s, settings.key.y * s, settings.key.z * s);
  keyLight.target.position.set(c.x, c.y + modelHalfHeight * modelContainer.scale.y, c.z);
  keyLight.target.updateMatrixWorld();
  fillLight.position.set(settings.fill.x * s, settings.fill.y * s, settings.fill.z * s);
  fillLight.target.position.copy(keyLight.target.position);
  fillLight.target.updateMatrixWorld();
}

let _shadowsWereEnabled = null;
function applyShadows() {
  const enabled = settings.shadow.enabled;
  renderer.shadowMap.enabled = enabled;
  keyLight.castShadow = enabled;
  const q = SHADOW_QUALITY[settings.shadow.quality] || SHADOW_QUALITY.medium;
  if (keyLight.shadow.mapSize.width !== q.size) {
    keyLight.shadow.mapSize.set(q.size, q.size);
    if (keyLight.shadow.map) {
      keyLight.shadow.map.dispose();
      keyLight.shadow.map = null; // force regeneration at new resolution
    }
  }
  keyLight.shadow.bias = settings.shadow.bias;
  updateShadowCamera(); // frustum + scale-aware normal bias
  groundMesh.receiveShadow = settings.ground.receive;
  // Toggling shadow support on/off at runtime needs the shaders recompiled,
  // otherwise the ground ShadowMaterial keeps sampling the retained shadow map.
  if (_shadowsWereEnabled !== enabled) {
    _shadowsWereEnabled = enabled;
    scene.traverse((o) => {
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => (m.needsUpdate = true));
      }
    });
  }
  renderer.shadowMap.needsUpdate = true;
  invalidate();
}

function applyGround() {
  groundMesh.visible = settings.ground.enabled && !ar.active;
  groundMat.opacity = settings.ground.opacity;
  groundMat.color.set(settings.ground.color);
  groundMesh.receiveShadow = settings.ground.receive;
  updateGroundFollow();
  invalidate();
}

// The ground follows the model's base and is sized relative to the model.
function updateGroundFollow() {
  const c = modelContainer.position;
  groundMesh.position.set(c.x, c.y, c.z);
  const s = Math.max(0.5, settings.ground.size) * modelScaleFactor();
  groundMesh.scale.set(s, s, 1);
}

function updateShadowCamera() {
  const R = Math.max(modelScaleFactor(), 0.5);
  const cam = keyLight.shadow.camera;
  cam.left = -R * 1.6;
  cam.right = R * 1.6;
  cam.top = R * 1.6;
  cam.bottom = -R * 1.6;
  cam.near = 0.05;
  cam.far = R * 30 + 30;
  cam.updateProjectionMatrix();
  // Normal bias is a world-space offset, so it has to follow the shadow texel
  // size (frustum / map resolution): otherwise large models get acne and tiny
  // ones get detached shadows. Reference texel = R 0.5 at a 1024 map.
  const texel = (R * 3.2) / keyLight.shadow.mapSize.width;
  keyLight.shadow.normalBias = settings.shadow.normalBias * (texel / (1.6 / 1024));
}

// Everything that depends on the model's world size/position.
function updateModelDependents() {
  updateGroundFollow();
  updateLightRig();
  updateShadowCamera();
}

function applyTransform() {
  if (ar.active && ar.placed) {
    applyARPlacement();
    return;
  }
  const t = settings.transform;
  modelContainer.position.set(t.px, t.py, t.pz);
  modelContainer.rotation.set(deg2rad(t.rx), deg2rad(t.ry), deg2rad(t.rz));
  modelContainer.scale.setScalar(t.scale);
  updateModelDependents();
  invalidate();
}

function applyPerformance() {
  const q = PERF_QUALITY[settings.performance.quality] || PERF_QUALITY.medium;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  resizeToDisplay(); // re-match the drawing buffer to the new pixel ratio
  invalidate();
}

function applyAll() {
  applyEnvironment();
  applyLighting();
  applyShadows();
  applyGround();
  applyTransform();
  applyPerformance();
}

// ===========================================================================
// Control factory (config-driven UI)
// ===========================================================================
const ui = {}; // id -> { refresh() }

function addGroupTitle(parent, text) {
  parent.appendChild(el('div', 'ctrl-group-title', text));
}

function addSlider(parent, { id, label, min, max, step, get, set, unit }) {
  const wrap = el('div', 'ctrl');
  const row = el('div', 'ctrl-row');
  const lab = el('label', 'ctrl-label', label);
  lab.htmlFor = id;
  const val = el('span', 'ctrl-value');
  row.append(lab, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = min;
  input.max = max;
  input.step = step;
  const dec = stepDecimals(step);
  const fmt = (v) => `${Number(v).toFixed(dec)}${unit || ''}`;
  const refresh = () => {
    const v = get();
    input.value = v;
    val.textContent = fmt(v);
  };
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    set(v);
    val.textContent = fmt(v);
    saveSettings();
  });
  wrap.append(row, input);
  parent.append(wrap);
  ui[id] = { refresh };
  refresh();
}

function addToggle(parent, { id, label, get, set }) {
  const row = el('div', 'ctrl-row');
  const lab = el('label', 'ctrl-label', label);
  lab.htmlFor = id;
  const sw = el('label', 'switch');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  const track = el('span', 'track');
  sw.append(input, track);
  const refresh = () => {
    input.checked = !!get();
  };
  input.addEventListener('change', () => {
    set(input.checked);
    saveSettings();
  });
  row.append(lab, sw);
  parent.append(row);
  ui[id] = { refresh };
  refresh();
}

function addSelect(parent, { id, label, options, get, set }) {
  const wrap = el('div', 'ctrl');
  if (label) {
    const row = el('div', 'ctrl-row');
    const lab = el('label', 'ctrl-label', label);
    lab.htmlFor = id;
    row.append(lab);
    wrap.append(row);
  }
  const select = document.createElement('select');
  select.id = id;
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    select.append(o);
  }
  const refresh = () => {
    select.value = get();
  };
  select.addEventListener('change', () => {
    set(select.value);
    saveSettings();
  });
  wrap.append(select);
  parent.append(wrap);
  ui[id] = { refresh };
  refresh();
}

function addColor(parent, { id, label, get, set }) {
  const row = el('div', 'ctrl-row');
  const lab = el('label', 'ctrl-label', label);
  lab.htmlFor = id;
  const input = document.createElement('input');
  input.type = 'color';
  input.id = id;
  const refresh = () => {
    input.value = get();
  };
  input.addEventListener('input', () => {
    set(input.value);
    saveSettings();
  });
  row.append(lab, input);
  parent.append(row);
  ui[id] = { refresh };
  refresh();
}

function addButtons(parent, buttons, cols = 2) {
  const grid = el('div', cols === 3 ? 'btn-grid-3' : 'btn-grid');
  for (const b of buttons) {
    const btn = el('button', `btn ${b.cls || ''}`.trim(), b.label);
    btn.type = 'button';
    btn.addEventListener('click', b.onClick);
    if (b.id) btn.id = b.id;
    if (b.title) btn.title = b.title;
    for (const [k, v] of Object.entries(b.data || {})) btn.dataset[k] = v;
    grid.append(btn);
  }
  parent.append(grid);
}

function refreshPresetButtons() {
  document.querySelectorAll('#sec-presets [data-preset]').forEach((b) => {
    const on = b.dataset.preset === settings.preset;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function refreshAllControls() {
  for (const k of Object.keys(ui)) ui[k].refresh?.();
  refreshPresetButtons();
}

// A settings getter/setter helper that also applies + is concise.
const bind = (obj, key, applyFn) => ({
  get: () => obj[key],
  set: (v) => {
    obj[key] = v;
    applyFn();
  },
});

// Manual lighting/shadow/environment edits mean the scene no longer matches a
// named preset — drop the highlight.
const asCustom = (applyFn) => () => {
  if (settings.preset !== 'custom') {
    settings.preset = 'custom';
    refreshPresetButtons();
  }
  applyFn();
};

// ===========================================================================
// Build settings panel
// ===========================================================================
function buildSettingsUI() {
  // ---- Presets ----
  const presets = $('#sec-presets');
  addGroupTitle(presets, 'Lighting presets');
  addButtons(
    presets,
    Object.keys(LIGHTING_PRESETS).map((key) => ({
      label: key.charAt(0).toUpperCase() + key.slice(1),
      data: { preset: key },
      onClick: () => applyLightingPreset(key),
    })),
    2
  );

  // ---- Lighting ----
  const light = $('#sec-lighting');
  const L = asCustom(applyLighting);
  addGroupTitle(light, 'Ambient / Hemisphere');
  addToggle(light, { id: 'amb-en', label: 'Enabled', ...bind(settings.ambient, 'enabled', L) });
  addSlider(light, { id: 'amb-int', label: 'Intensity', min: 0, max: 4, step: 0.05, ...bind(settings.ambient, 'intensity', L) });
  addColor(light, { id: 'amb-sky', label: 'Sky color', ...bind(settings.ambient, 'sky', L) });
  addColor(light, { id: 'amb-gnd', label: 'Ground color', ...bind(settings.ambient, 'ground', L) });

  addGroupTitle(light, 'Key light (casts shadows)');
  addToggle(light, { id: 'key-en', label: 'Enabled', ...bind(settings.key, 'enabled', L) });
  addSlider(light, { id: 'key-int', label: 'Intensity', min: 0, max: 10, step: 0.05, ...bind(settings.key, 'intensity', L) });
  addColor(light, { id: 'key-col', label: 'Color', ...bind(settings.key, 'color', L) });
  addSlider(light, { id: 'key-x', label: 'Position X', min: -12, max: 12, step: 0.1, ...bind(settings.key, 'x', L) });
  addSlider(light, { id: 'key-y', label: 'Position Y', min: -12, max: 12, step: 0.1, ...bind(settings.key, 'y', L) });
  addSlider(light, { id: 'key-z', label: 'Position Z', min: -12, max: 12, step: 0.1, ...bind(settings.key, 'z', L) });

  addGroupTitle(light, 'Fill light');
  addToggle(light, { id: 'fill-en', label: 'Enabled', ...bind(settings.fill, 'enabled', L) });
  addSlider(light, { id: 'fill-int', label: 'Intensity', min: 0, max: 6, step: 0.05, ...bind(settings.fill, 'intensity', L) });
  addColor(light, { id: 'fill-col', label: 'Color', ...bind(settings.fill, 'color', L) });
  addSlider(light, { id: 'fill-x', label: 'Position X', min: -12, max: 12, step: 0.1, ...bind(settings.fill, 'x', L) });
  addSlider(light, { id: 'fill-y', label: 'Position Y', min: -12, max: 12, step: 0.1, ...bind(settings.fill, 'y', L) });
  addSlider(light, { id: 'fill-z', label: 'Position Z', min: -12, max: 12, step: 0.1, ...bind(settings.fill, 'z', L) });
  light.appendChild(el('div', 'muted', 'Key/fill positions are relative to the model size, so the rig works for tiny and huge models alike.'));

  addGroupTitle(light, 'Point light');
  addToggle(light, { id: 'pt-en', label: 'Enabled', ...bind(settings.point, 'enabled', L) });
  addSlider(light, { id: 'pt-int', label: 'Intensity', min: 0, max: 100, step: 1, ...bind(settings.point, 'intensity', L) });
  addColor(light, { id: 'pt-col', label: 'Color', ...bind(settings.point, 'color', L) });
  addSlider(light, { id: 'pt-x', label: 'Position X', min: -12, max: 12, step: 0.1, ...bind(settings.point, 'x', L) });
  addSlider(light, { id: 'pt-y', label: 'Position Y', min: -12, max: 12, step: 0.1, ...bind(settings.point, 'y', L) });
  addSlider(light, { id: 'pt-z', label: 'Position Z', min: -12, max: 12, step: 0.1, ...bind(settings.point, 'z', L) });
  addSlider(light, { id: 'pt-dist', label: 'Distance (0=∞)', min: 0, max: 50, step: 0.5, ...bind(settings.point, 'distance', L) });
  addSlider(light, { id: 'pt-decay', label: 'Decay', min: 0, max: 4, step: 0.1, ...bind(settings.point, 'decay', L) });

  // ---- Shadows ----
  const shadow = $('#sec-shadows');
  const S = asCustom(applyShadows);
  addToggle(shadow, { id: 'sh-en', label: 'Shadows enabled', ...bind(settings.shadow, 'enabled', S) });
  addSelect(shadow, {
    id: 'sh-q',
    label: 'Quality',
    options: Object.entries(SHADOW_QUALITY).map(([k, v]) => ({ value: k, label: `${v.label} (${v.size})` })),
    ...bind(settings.shadow, 'quality', S),
  });
  addSlider(shadow, { id: 'sh-bias', label: 'Bias', min: -0.005, max: 0.005, step: 0.0001, ...bind(settings.shadow, 'bias', S) });
  addSlider(shadow, { id: 'sh-nbias', label: 'Normal bias', min: 0, max: 0.2, step: 0.005, ...bind(settings.shadow, 'normalBias', S) });
  shadow.appendChild(el('div', 'muted', 'Tip: the contact shadow is subtle on very dark backgrounds — raise Ground → Opacity or lighten the Background to see it clearly.'));

  // ---- Environment ----
  const env = $('#sec-environment');
  const E = asCustom(applyEnvironment);
  addColor(env, { id: 'env-bg', label: 'Background', ...bind(settings.env, 'background', E) });
  addSelect(env, {
    id: 'env-tm',
    label: 'Tone mapping',
    options: Object.entries(TONE_MAPPING).map(([k, v]) => ({ value: k, label: v.label })),
    ...bind(settings.env, 'toneMapping', E),
  });
  addSlider(env, { id: 'env-exp', label: 'Exposure', min: 0, max: 2, step: 0.01, ...bind(settings.env, 'exposure', E) });
  addSlider(env, { id: 'env-ei', label: 'Environment intensity', min: 0, max: 3, step: 0.05, ...bind(settings.env, 'envIntensity', E) });

  // ---- Ground ----
  const ground = $('#sec-ground');
  addToggle(ground, { id: 'gr-en', label: 'Ground enabled', ...bind(settings.ground, 'enabled', applyGround) });
  addToggle(ground, { id: 'gr-recv', label: 'Receive shadows', ...bind(settings.ground, 'receive', () => { applyGround(); applyShadows(); }) });
  addSlider(ground, { id: 'gr-op', label: 'Opacity', min: 0, max: 1, step: 0.02, ...bind(settings.ground, 'opacity', applyGround) });
  addSlider(ground, { id: 'gr-size', label: 'Size (× model)', min: 1, max: 40, step: 0.5, ...bind(settings.ground, 'size', applyGround) });
  addColor(ground, { id: 'gr-col', label: 'Shadow color', ...bind(settings.ground, 'color', applyGround) });

  // ---- Model transform ----
  const model = $('#sec-model');
  addGroupTitle(model, 'Position');
  addSlider(model, { id: 'tr-px', label: 'X', min: -10, max: 10, step: 0.05, ...bind(settings.transform, 'px', applyTransform) });
  addSlider(model, { id: 'tr-py', label: 'Y', min: -10, max: 10, step: 0.05, ...bind(settings.transform, 'py', applyTransform) });
  addSlider(model, { id: 'tr-pz', label: 'Z', min: -10, max: 10, step: 0.05, ...bind(settings.transform, 'pz', applyTransform) });
  addGroupTitle(model, 'Rotation (degrees)');
  addSlider(model, { id: 'tr-rx', label: 'X', min: -180, max: 180, step: 1, ...bind(settings.transform, 'rx', applyTransform) });
  addSlider(model, { id: 'tr-ry', label: 'Y', min: -180, max: 180, step: 1, ...bind(settings.transform, 'ry', applyTransform) });
  addSlider(model, { id: 'tr-rz', label: 'Z', min: -180, max: 180, step: 1, ...bind(settings.transform, 'rz', applyTransform) });
  addGroupTitle(model, 'Scale');
  addSlider(model, { id: 'tr-sc', label: 'Uniform', min: 0.05, max: 5, step: 0.05, ...bind(settings.transform, 'scale', applyTransform) });
  addButtons(
    model,
    [
      { label: 'Reset transform', onClick: resetTransform },
      { label: 'Center model', onClick: centerModel },
      { label: 'Fit camera', title: 'Shortcut: F or double-click the viewer', onClick: () => fitCameraToObject(modelContainer) },
    ],
    3
  );

  // ---- Performance ----
  const perf = $('#sec-performance');
  addSelect(perf, {
    id: 'perf-q',
    label: 'Render quality (Quest-friendly = Medium)',
    options: Object.entries(PERF_QUALITY).map(([k, v]) => ({ value: k, label: `${v.label} (×${v.pixelRatio})` })),
    ...bind(settings.performance, 'quality', applyPerformance),
  });

  // ---- AR ----
  const arSec = $('#sec-ar');
  addSelect(arSec, {
    id: 'ar-light',
    label: 'AR lighting',
    options: Object.entries(AR_LIGHTING).map(([k, v]) => ({ value: k, label: v.label })),
    ...bind(settings.ar, 'lighting', () => { if (ar.active) applyARLighting(); }),
  });
  arSec.appendChild(el('div', 'muted', 'AR lighting adjusts the viewer lights for passthrough. "Auto" uses WebXR light estimation when the device exposes it, otherwise a neutral fallback.'));

  refreshPresetButtons();
}

// Remember which settings sections are expanded.
function persistSections() {
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}');
  } catch (e) {
    /* ignore */
  }
  document.querySelectorAll('#settings-panel details.section').forEach((d) => {
    const key = d.querySelector('.section-body')?.id;
    if (!key) return;
    if (key in state) d.open = !!state[key];
    d.addEventListener('toggle', () => {
      state[key] = d.open;
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(state));
      } catch (e) {
        /* ignore */
      }
    });
  });
}

// ===========================================================================
// Presets, transform actions
// ===========================================================================
function applyLightingPreset(key) {
  const p = LIGHTING_PRESETS[key];
  if (!p) return;
  deepMerge(settings, p);
  settings.preset = key;
  applyAll();
  refreshAllControls();
  saveSettings();
}

function resetTransform() {
  Object.assign(settings.transform, DEFAULT_TRANSFORM); // mutate in place — controls hold a ref to this object
  ar.yaw = 0;
  ar.scaleMul = 1;
  applyTransform();
  refreshAllControls();
  saveSettings();
  fitCameraToObject(modelContainer);
}

function centerModel() {
  if (currentInner) normalizeModel(currentInner);
  settings.transform.px = 0;
  settings.transform.py = 0;
  settings.transform.pz = 0;
  applyTransform();
  refreshAllControls();
  saveSettings();
  fitCameraToObject(modelContainer);
}

function resetAllSettings() {
  // Mutate in place (deep) rather than reassigning `settings`, so the control
  // get/set closures — which captured references to the sub-objects — stay live.
  deepMerge(settings, structuredClone(DEFAULT_SETTINGS));
  applyAll();
  refreshAllControls();
  saveSettings();
  fitCameraToObject(modelContainer);
}

// ===========================================================================
// Model loading
// ===========================================================================
const _box = new Box3();
const _sphere = new Sphere();
let embeddedLights = [];
let loadedModelName = null; // what is actually displayed (may differ from the list selection after a failed load)

function normalizeModel(group) {
  group.position.set(0, 0, 0);
  group.updateMatrixWorld(true);
  _box.setFromObject(group);
  if (_box.isEmpty()) return;
  const center = _box.getCenter(new Vector3());
  const size = _box.getSize(new Vector3());
  group.position.x = -center.x;
  group.position.z = -center.z;
  group.position.y = -_box.min.y;
  modelSize.copy(size);
  modelHalfHeight = Math.max(size.y / 2, 0.01);
  modelRadius = Math.max(0.5 * Math.hypot(size.x, size.y, size.z), 0.25);
}

function disposeMaterial(material) {
  for (const key in material) {
    const val = material[key];
    if (val && val.isTexture) val.dispose();
  }
  material.dispose();
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(disposeMaterial);
  });
}

function disposeCurrentModel() {
  if (!currentInner) return;
  teardownAnimation();
  modelContainer.remove(currentInner);
  disposeGroup(currentInner);
  currentInner = null;
  embeddedLights = [];
  renderEmbeddedList();
  invalidate();
}

function detectEmbeddedLights(group) {
  embeddedLights = [];
  group.traverse((o) => {
    if (o.isLight) {
      embeddedLights.push({ light: o, name: o.name || o.type, originalIntensity: o.intensity, enabled: true });
    }
  });
  renderEmbeddedList();
}

function fitCameraToObject(object3d, offset = 1.2) {
  resizeToDisplay(); // ensure camera.aspect matches the current viewport before fitting
  _box.setFromObject(object3d);
  if (_box.isEmpty()) return;
  _box.getBoundingSphere(_sphere);
  const center = _sphere.center;
  const r = Math.max(_sphere.radius, 0.001);
  const vFov = (camera.fov * Math.PI) / 180;
  // Distance so the bounding sphere fits the vertical FOV, widened for narrow
  // (portrait) viewports so the model never clips horizontally.
  let dist = r / Math.sin(vFov / 2);
  if (camera.aspect < 1) dist /= camera.aspect;
  dist *= offset;
  const dir = new Vector3(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(r * 0.05, 0.0005); // ~6.5k:1 far/near keeps the 24-bit depth buffer precise (no z-fighting)
  camera.far = dist * 100 + r * 40;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = r * 0.2;
  controls.maxDistance = dist * 12;
  controls.update();
  invalidate();
}

// Put a parsed USD group on stage: replaces the current model, normalizes it,
// enables shadows, re-rigs lights/ground/shadow frustum, and frames the camera.
function installGroup(group, displayName, meta = {}) {
  disposeCurrentModel();
  normalizeModel(group);
  // Shadows on every mesh; anisotropic filtering so textures stay sharp at
  // grazing angles (4 is a Quest-friendly level).
  const aniso = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const seenTex = new Set();
  group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const k in m) {
        const t = m[k];
        if (t && t.isTexture && !seenTex.has(t)) {
          seenTex.add(t);
          if (t.anisotropy < aniso) {
            t.anisotropy = aniso;
            t.needsUpdate = true;
          }
        }
      }
    }
  });
  modelContainer.add(group);
  currentInner = group;
  detectEmbeddedLights(group);
  applyTransform(); // also re-rigs lights, ground and the shadow camera for the new size
  applyGround();
  if (!meta.keepCamera) fitCameraToObject(modelContainer);
  setupAnimation(group);
  renderModelInfo(displayName, group, meta);
  if (meta.thumbKey && !ar.active) maybeRequestThumbnail(meta.thumbKey, meta.thumbVersion);
  loadedModelName = displayName;
  setCurrentModelName(displayName);
  setLoading(false);
  invalidate();
}

// Turn loader errors into something a user can act on.
function describeLoadError(err, name) {
  const msg = String(err?.message || err || 'unknown error');
  if (/\b404\b|not found/i.test(msg)) return `"${name}" was not found on the server — it may have been removed. Refresh the model list.`;
  if (/\b(5\d\d)\b/.test(msg)) return `The server failed while sending "${name}" (${msg}).`;
  if (/failed to fetch|network|load failed|aborted/i.test(msg)) return `Network error while downloading "${name}". Check the connection and try again.`;
  if (/zip|usdz|crate|parse|unexpected|invalid|malformed|token/i.test(msg)) return `"${name}" could not be parsed — it may be corrupted or use USD features this viewer does not support. (${msg})`;
  return `Failed to load "${name}". (${msg})`;
}

function onLoadFailed(err, name, token) {
  if (token !== loadToken) return;
  console.error('Model load failed:', err);
  setLoading(false);
  showError(describeLoadError(err, name));
  // Keep the UI consistent with what is really on stage.
  activeModelName = loadedModelName;
  renderModelList();
  if (!currentInner) showEmpty('Nothing loaded', 'Pick another model, or drop a USD file here.');
}

const formatPct = (e) => (e && e.lengthComputable && e.total > 0 ? ` ${Math.round((e.loaded / e.total) * 100)}%` : '');

// ---- USD parsing ------------------------------------------------------------
// Mirrors USDLoader.parse() using the same parsers/composer, but exposes the
// composer's variant-selection argument and enumerates the file's variant sets.
const fileLoader = new FileLoader().setResponseType('arraybuffer');
const CRATE_MAGIC = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]; // "PXR-USDC"
const isCrate = (u8) => u8.byteLength >= 8 && CRATE_MAGIC.every((b, i) => u8[i] === b);
const lowerExt = (name) => {
  const d = name.lastIndexOf('.');
  const s = name.lastIndexOf('/');
  return d < 0 || s > d ? '' : name.slice(d + 1).toLowerCase();
};
const asArrayBuffer = (u8) =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

// Variant sets: a prim lists its sets in fields.variantSetChildren, the options
// live on "<prim>/{set=}" (fields.variantChildren) and the file's own choice in
// fields.variantSelection. Selections are global per set name (as the composer
// applies them), so identically named sets on several prims switch together.
function enumerateVariants(parsed) {
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
    .map((s) => ({ name: s.name, options: [...s.options], selected: s.selected || [...s.options][0] || null }))
    .filter((s) => s.options.length > 1);
}

// USD material-binding strength: a binding authored on an ancestor prim with
// bindMaterialAs = "strongerThanDescendants" overrides the bindings of every
// mesh below it. three's composer resolves each mesh's own binding only, so
// variants that switch materials this way (a common exporter pattern) would
// fall back to placeholder materials. Propagate such bindings down to the Mesh
// descendants in the spec table before composing.
const stripVariantSegments = (p) => p.replace(/\/\{[^}]*\}/g, '');
function propagateStrongBindings(specs) {
  if (!specs) return;
  const REL = '.material:binding';
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
  for (const k in specs) {
    if (!isPrimKey(k)) continue;
    const anc = strong.find((a) => k.startsWith(a.prim + '/'));
    if (!anc || !isMesh(k)) continue;
    specs[k + REL] = { ...anc.spec, fields: { ...anc.spec.fields, bindMaterialAs: 'weakerThanDescendants' } };
    const props = specs[k].fields?.properties;
    if (Array.isArray(props) && !props.includes('material:binding')) specs[k].fields.properties = [...props, 'material:binding'];
  }
}

// Synchronous compose; textures resolve through the returned promise.
function composeUSD(buffer, variantSelections = {}) {
  const usda = new USDAParser();
  const usdc = new USDCParser();
  const decoder = new TextDecoder();
  const bytes = new Uint8Array(buffer);
  let data;
  const assets = {};
  let basePath = '';
  if (isCrate(bytes)) {
    data = usdc.parseData(buffer);
  } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = unzipSync(bytes);
    const names = Object.keys(zip);
    if (!names.length) throw new Error('Empty USDZ archive');
    for (const name of names) {
      const ext = lowerExt(name);
      const fb = zip[name];
      if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'avif') {
        assets[name] = fb; // raw image bytes; the composer creates object URLs lazily
        continue;
      }
      if (ext !== 'usd' && ext !== 'usda' && ext !== 'usdc') continue;
      assets[name] = isCrate(fb) ? usdc.parseData(asArrayBuffer(fb)) : usda.parseData(decoder.decode(fb));
    }
    const first = names[0]; // per the USDZ spec the first entry is the root layer
    const slash = first.lastIndexOf('/');
    basePath = slash >= 0 ? first.slice(0, slash) : '';
    data = assets[first];
    if (!data) throw new Error(`Invalid USDZ package: the first entry ("${first}") must be a USD layer.`);
  } else {
    data = usda.parseData(decoder.decode(bytes));
  }
  propagateStrongBindings(data?.specsByPath);
  _lastParsedData = data;
  const composer = new USDComposer(DefaultLoadingManager);
  const group = composer.compose(data, assets, variantSelections, basePath);
  return { group, variants: enumerateVariants(data), ready: Promise.all(composer.texturePromises || []), data, assets, basePath };
}

// Parse off the current task (so the "Loading…" text paints first) and wait
// for the textures.
async function parseBuffer(buffer, variantSelections = {}) {
  await new Promise((r) => setTimeout(r, 20));
  const result = composeUSD(buffer, variantSelections);
  await result.ready;
  // Materials driven by MaterialX node graphs (procedural recolours etc.) are
  // beyond the composer; bake them to textures so variants render correctly.
  try {
    const effective = Object.fromEntries(result.variants.map((v) => [v.name, variantSelections[v.name] || v.selected]));
    const { applied, notes } = await applyMaterialXFallbacks(result.group, result.data?.specsByPath, result.assets, effective, result.basePath, (msg) => setLoading(true, msg));
    result.materialNotes = notes;
    if (applied) console.info(`MaterialX: baked ${applied} texture map${applied === 1 ? '' : 's'} the composer could not resolve.`);
    for (const note of notes) console.info('MaterialX:', note);
  } catch (e) {
    console.warn('MaterialX fallback failed:', e);
  }
  return result;
}

// The source of the model on stage, kept so variants can be switched without
// a re-download. Cleared whenever another model starts loading.
const source = { buffer: null, name: null, meta: null, variants: [], selections: {}, notes: [] };
let _lastParsedData = null; // root layer of the last compose (debug/inspection)
function rememberSource(buffer, name, meta, variants, notes = []) {
  source.notes = notes;
  source.buffer = buffer;
  source.name = name;
  source.meta = meta;
  source.variants = variants;
  source.selections = Object.fromEntries(variants.map((v) => [v.name, v.selected]));
  renderVariantsUI();
}
function forgetSource() {
  clearMaterialXCache();
  source.buffer = null;
  source.name = null;
  source.meta = null;
  source.variants = [];
  source.selections = {};
  source.notes = [];
  renderVariantsUI();
}

let loadToken = 0;
async function loadModel(model) {
  const token = ++loadToken;
  forgetSource();
  setLoading(true, `Loading ${model.name}…`);
  clearError();
  hideEmpty();
  try {
    const buffer = await fileLoader.loadAsync(model.url, (e) => {
      if (token === loadToken) setLoading(true, `Loading ${model.name}…${formatPct(e)}`);
    });
    if (token !== loadToken) return; // a newer selection superseded this one
    setLoading(true, `Preparing ${model.name}…`);
    const parsed = await parseBuffer(buffer);
    if (token !== loadToken) {
      disposeGroup(parsed.group);
      return;
    }
    const meta = { size: model.size, extension: model.extension, thumbKey: model.name, thumbVersion: model.modified };
    rememberSource(buffer, model.name, meta, parsed.variants, parsed.materialNotes); // before install so Model info sees the sets
    installGroup(parsed.group, model.name, meta);
  } catch (err) {
    onLoadFailed(err, model.name, token);
  }
}

// Re-compose the current model with a different variant selection.
async function applyVariant(setName, option) {
  if (!source.buffer) return;
  const token = ++loadToken;
  source.selections = { ...source.selections, [setName]: option };
  setLoading(true, `Switching ${setName} → ${option}…`);
  clearError();
  try {
    const parsed = await parseBuffer(source.buffer, source.selections);
    if (token !== loadToken) {
      disposeGroup(parsed.group);
      return;
    }
    source.variants = parsed.variants.map((v) => ({ ...v, selected: source.selections[v.name] || v.selected }));
    source.notes = parsed.materialNotes || [];
    renderVariantsUI();
    installGroup(parsed.group, source.name, { ...source.meta, thumbKey: undefined, keepCamera: true });
  } catch (err) {
    onLoadFailed(err, source.name, token);
  }
}

function renderVariantsUI() {
  const sec = $('#sec-variants');
  const details = $('#details-variants');
  sec.innerHTML = '';
  for (const k of Object.keys(ui)) if (k.startsWith('var-')) delete ui[k];
  const sets = source.variants;
  if (!sets.length) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  $('#variants-count').textContent = String(sets.length);
  sec.append(el('div', 'muted', 'Variant sets defined in the USD file. Switching re-composes the model from the file already downloaded; the camera stays put.'));
  if (source.notes.length) {
    const box = el('div', 'muted');
    box.textContent = 'Rendering notes: ' + source.notes.join(' · ');
    sec.append(box);
  }
  sets.forEach((v, i) => {
    addSelect(sec, {
      id: `var-${i}`,
      label: v.name,
      options: v.options.map((o) => ({ value: o, label: o })),
      get: () => source.selections[v.name] || v.selected,
      set: (val) => applyVariant(v.name, val),
    });
  });
}

// Preview a file from the user's machine without uploading it anywhere.
async function loadLocalFile(file) {
  if (!MODEL_EXTENSIONS.includes(extOf(file.name))) {
    showError(`"${file.name}" is not a USD file (.usd, .usda, .usdc or .usdz).`);
    return;
  }
  const token = ++loadToken;
  const name = `${file.name} (local file)`;
  forgetSource();
  setLoading(true, `Reading ${file.name}…`);
  clearError();
  hideEmpty();
  try {
    const buffer = await file.arrayBuffer();
    if (token !== loadToken) return;
    const parsed = await parseBuffer(buffer);
    if (token !== loadToken) {
      disposeGroup(parsed.group);
      return;
    }
    activeModelName = null; // not one of the server models
    Object.assign(settings.transform, DEFAULT_TRANSFORM);
    ar.yaw = 0;
    ar.scaleMul = 1;
    ar.placed = false;
    refreshAllControls();
    renderModelList();
    setUrlModel(null); // a local file has no shareable server URL
    const meta = { size: file.size, extension: extOf(file.name) };
    rememberSource(buffer, name, meta, parsed.variants, parsed.materialNotes);
    installGroup(parsed.group, name, meta);
  } catch (err) {
    onLoadFailed(err, file.name, token);
  }
}

// ===========================================================================
// Animation playback (USD time samples / skeletal clips → AnimationMixer)
// ===========================================================================
// Frame timing from the animation-loop timestamp (THREE.Clock is deprecated in
// r186, and a hidden tab must not produce one giant delta when it resumes).
let _lastFrameTime = 0;
function frameDelta(now) {
  const dt = _lastFrameTime ? (now - _lastFrameTime) / 1000 : 0;
  _lastFrameTime = now;
  return clamp(dt, 0, 0.1);
}
const anim = { mixer: null, clips: [], action: null, index: 0, playing: false, speed: 1 };
let _scrubWasPlaying = false;
let _lastTick = -1;
const fmtTime = (t) => `${t.toFixed(1)} s`;

function setupAnimation(group) {
  const clips = (Array.isArray(group.animations) ? group.animations : []).filter((c) => c && c.duration > 0);
  if (!clips.length) {
    updateTransportUI();
    return;
  }
  // Skinned bounds come from the bind pose, so let skinned meshes skip frustum
  // culling — otherwise limbs can vanish at the viewport edge mid-animation.
  group.traverse((o) => {
    if (o.isSkinnedMesh) o.frustumCulled = false;
  });
  anim.mixer = new AnimationMixer(group);
  anim.mixer.timeScale = anim.speed;
  anim.clips = clips;
  playClip(0);
}

function teardownAnimation() {
  if (anim.mixer) {
    anim.mixer.stopAllAction();
    if (currentInner) anim.mixer.uncacheRoot(currentInner);
  }
  anim.mixer = null;
  anim.clips = [];
  anim.action = null;
  anim.playing = false;
  updateTransportUI();
}

function playClip(i) {
  if (!anim.mixer || !anim.clips.length) return;
  anim.index = clamp(i, 0, anim.clips.length - 1);
  anim.mixer.stopAllAction();
  anim.action = anim.mixer.clipAction(anim.clips[anim.index]);
  anim.action.reset().play();
  anim.playing = true;
  updateTransportUI();
  invalidate();
}

function setPlaying(on) {
  if (!anim.action) return;
  anim.playing = on;
  anim.action.paused = !on;
  updateTransportUI();
  invalidate();
}

function seekTo(t) {
  if (!anim.action) return;
  anim.action.time = clamp(t, 0, anim.clips[anim.index].duration);
  anim.mixer.update(0); // apply the pose at the new time even while paused
  updateTransportTime();
  invalidate();
}

function setSpeed(s) {
  anim.speed = s;
  if (anim.mixer) anim.mixer.timeScale = s;
}

// Called every frame from render(); advances the mixer while playing.
function tickAnimation(dt) {
  if (!anim.mixer || !anim.playing) return;
  anim.mixer.update(dt);
  invalidate(1);
  const k = Math.floor(anim.action.time * 10); // throttle DOM writes to ~10 Hz
  if (k !== _lastTick) {
    _lastTick = k;
    updateTransportTime();
  }
}

function updateTransportTime() {
  if (!anim.action) return;
  const d = anim.clips[anim.index].duration;
  const t = clamp(anim.action.time, 0, d);
  const scrub = $('#anim-scrub');
  if (document.activeElement !== scrub) scrub.value = t; // don't fight the user's drag
  $('#anim-time').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
}

function updateTransportUI() {
  const has = anim.clips.length > 0;
  $('#anim-bar').hidden = !has;
  const arBtn = document.querySelector('#ar-controls [data-ar="anim"]');
  if (arBtn) {
    arBtn.hidden = !has;
    arBtn.textContent = anim.playing ? '⏸' : '▶';
  }
  if (!has) return;
  const play = $('#anim-play');
  play.textContent = anim.playing ? '⏸' : '▶';
  play.setAttribute('aria-label', anim.playing ? 'Pause' : 'Play');
  const sel = $('#anim-clip');
  sel.innerHTML = '';
  anim.clips.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.name || `Clip ${i + 1}`} (${fmtTime(c.duration)})`;
    sel.append(o);
  });
  sel.value = String(anim.index);
  sel.hidden = anim.clips.length < 2;
  const scrub = $('#anim-scrub');
  scrub.max = anim.clips[anim.index].duration;
  scrub.step = Math.max(anim.clips[anim.index].duration / 500, 0.001);
  $('#anim-speed').value = String(anim.speed);
  updateTransportTime();
}

function wireTransport() {
  $('#anim-play').addEventListener('click', () => setPlaying(!anim.playing));
  const scrub = $('#anim-scrub');
  scrub.addEventListener('pointerdown', () => {
    _scrubWasPlaying = anim.playing;
    if (anim.playing) setPlaying(false); // pause while scrubbing
  });
  scrub.addEventListener('input', () => seekTo(parseFloat(scrub.value)));
  scrub.addEventListener('change', () => {
    if (_scrubWasPlaying) setPlaying(true);
    _scrubWasPlaying = false;
  });
  $('#anim-clip').addEventListener('change', (e) => playClip(parseInt(e.target.value, 10)));
  $('#anim-speed').addEventListener('change', (e) => setSpeed(parseFloat(e.target.value)));
}

// ===========================================================================
// Deep links & sharing (URL + QR code)
// ===========================================================================
function setUrlModel(name) {
  try {
    const url = new URL(location.href);
    if (name) url.searchParams.set('model', name);
    else url.searchParams.delete('model');
    history.replaceState(null, '', url);
  } catch (e) {
    /* ignore */
  }
}

function openShare() {
  const url = location.href;
  $('#share-url').value = url;
  const box = $('#share-qr');
  try {
    const qr = qrcode(0, 'M'); // type 0 = auto-size, medium error correction
    qr.addData(url);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) {
    box.textContent = 'Link is too long for a QR code — copy it instead.';
  }
  $('#share-copy').textContent = 'Copy';
  $('#share-modal').hidden = false;
}
function closeShare() {
  $('#share-modal').hidden = true;
}
async function copyShareUrl() {
  const input = $('#share-url');
  const btn = $('#share-copy');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch (e) {
    input.select();
    document.execCommand('copy');
  }
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = 'Copy'), 1500);
}

function wireShareAndTransport() {
  $('#share-btn').addEventListener('click', openShare);
  $('#share-close').addEventListener('click', closeShare);
  $('#share-modal').querySelector('.modal-backdrop').addEventListener('click', closeShare);
  $('#share-copy').addEventListener('click', copyShareUrl);
  wireTransport();
}

// ===========================================================================
// Model info panel
// ===========================================================================
function computeModelStats(group) {
  let meshes = 0;
  let skinned = 0;
  let tris = 0;
  let verts = 0;
  let lights = 0;
  const mats = new Set();
  const texs = new Set();
  group.traverse((o) => {
    if (o.isLight) lights++;
    if (!o.isMesh) return;
    meshes++;
    if (o.isSkinnedMesh) skinned++;
    const g = o.geometry;
    if (g) {
      const pos = g.getAttribute('position');
      const n = pos ? pos.count : 0;
      verts += n;
      tris += g.index ? g.index.count / 3 : n / 3;
    }
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      mats.add(m);
      for (const k in m) if (m[k] && m[k].isTexture) texs.add(m[k]);
    }
  });
  return { meshes, skinned, tris: Math.round(tris), verts, materials: mats.size, textures: texs.size, lights, clips: (group.animations || []).filter((c) => c && c.duration > 0).length };
}

function renderModelInfo(displayName, group, meta = {}) {
  const sec = $('#sec-info');
  sec.innerHTML = '';
  if (!group) {
    sec.append(el('div', 'muted', 'No model loaded.'));
    return;
  }
  const row = (k, v) => {
    const r = el('div', 'info-row');
    r.append(el('span', 'info-key', k), el('span', 'info-val', v));
    sec.append(r);
  };
  const s = computeModelStats(group);
  const m = (v) => v.toFixed(3);
  const cm = (v) => (v * 100).toFixed(1);
  row('Name', displayName);
  if (meta.extension) row('Format', String(meta.extension).toUpperCase());
  if (meta.size != null) row('File size', formatSize(meta.size));
  row('Size W × H × D', `${m(modelSize.x)} × ${m(modelSize.y)} × ${m(modelSize.z)} m`);
  row('', `${cm(modelSize.x)} × ${cm(modelSize.y)} × ${cm(modelSize.z)} cm`);
  row('Meshes', s.skinned ? `${s.meshes} (${s.skinned} skinned)` : String(s.meshes));
  row('Triangles', s.tris.toLocaleString());
  row('Vertices', s.verts.toLocaleString());
  row('Materials / textures', `${s.materials} / ${s.textures}`);
  if (s.lights) row('Embedded lights', String(s.lights));
  row('Animation clips', String(s.clips));
  if (source.variants.length) row('Variant sets', source.variants.map((v) => v.name).join(', '));
  sec.append(el('div', 'muted', 'Metres; the loader applies the file’s metersPerUnit and up-axis. Dimensions are the unscaled model.'));
}

// ===========================================================================
// Embedded USD lights UI
// ===========================================================================
function renderEmbeddedList() {
  const sec = $('#sec-embedded');
  const details = $('#details-embedded');
  const countPill = $('#embedded-count');
  sec.innerHTML = '';
  for (const k of Object.keys(ui)) if (k.startsWith('emb-')) delete ui[k]; // drop stale controls
  if (!embeddedLights.length) {
    details.hidden = true;
    return;
  }
  details.hidden = false;
  countPill.textContent = String(embeddedLights.length);
  sec.appendChild(el('div', 'muted', 'Lights defined inside the USD file (kept enabled by default). Independent of the viewer lights above.'));

  embeddedLights.forEach((entry, i) => {
    addGroupTitle(sec, `${entry.name} · ${entry.light.type}`);
    addToggle(sec, {
      id: `emb-en-${i}`,
      label: 'Enabled',
      get: () => entry.enabled,
      set: (v) => {
        entry.enabled = v;
        entry.light.visible = v;
        invalidate();
      },
    });
    const maxI = Math.max(entry.originalIntensity * 3, 1);
    addSlider(sec, {
      id: `emb-int-${i}`,
      label: 'Intensity',
      min: 0,
      max: Number(maxI.toFixed(2)),
      step: maxI / 200,
      get: () => entry.light.intensity,
      set: (v) => {
        entry.light.intensity = v;
        invalidate();
      },
    });
  });
}

// ===========================================================================
// Model list (modal)
// ===========================================================================
let models = [];
let activeModelName = null;

async function fetchModels({ autoload = false } = {}) {
  const listEl = $('#model-list');
  listEl.innerHTML = '<div class="list-empty">Loading models…</div>';
  try {
    const res = await fetch('/api/models', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    models = Array.isArray(data.models) ? data.models : [];
    renderModelList();
    $('#model-count').textContent = `${models.length} model${models.length === 1 ? '' : 's'}`;
    $('#data-note').textContent = data.warning ? `⚠ ${data.warning}` : '';
    if (!models.length) {
      if (!currentInner) showEmpty('No models found', 'Add USD/USDA/USDC/USDZ files to the ./data directory and press Refresh — or drop a file here.');
    } else if (autoload && !activeModelName && !currentInner) {
      // Honour a ?model= deep link (exact name first, then accent/case-insensitive).
      let wanted = null;
      if (linkedModel) {
        wanted =
          models.find((m) => m.name === linkedModel) ||
          models.find((m) => foldText(m.name) === foldText(linkedModel)) ||
          null;
      }
      selectModel(wanted || models[0]);
      if (linkedModel && !wanted) {
        showError(`The linked model "${linkedModel}" is not in ./data — opened the first model instead.`);
      }
    }
  } catch (err) {
    console.error('Failed to fetch models:', err);
    listEl.innerHTML = '';
    listEl.appendChild(el('div', 'list-empty', `Could not load model list (${err.message}).`));
    showError(`Could not reach the model API: ${err.message}`);
    if (!currentInner) showEmpty('Model list unavailable', 'Check that the server is running, then press Refresh.');
  }
}

// ---- Preview thumbnails ---------------------------------------------------
// Captured from the live canvas the first time a model is viewed (never by
// preloading the whole library) and kept in IndexedDB keyed by filename,
// versioned by the file's mtime so a re-exported model gets a fresh preview.
const THUMB_W = 320;
const THUMB_H = 240;
const thumbs = new Map(); // name -> { v, dataUrl, at }
const thumbWaiters = new Map(); // name -> resolve() (used by "Generate previews")
let thumbPending = null; // { name, version, framesLeft }

let _thumbDbPromise = null;
function thumbDb() {
  if (_thumbDbPromise) return _thumbDbPromise;
  _thumbDbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('usdz-viewer', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null); // e.g. storage disabled — previews just won't persist
    }
  });
  return _thumbDbPromise;
}

async function thumbLoadAll() {
  const db = await thumbDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const req = db.transaction('thumbs', 'readonly').objectStore('thumbs').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          thumbs.set(c.key, c.value);
          c.continue();
        } else resolve();
      };
      req.onerror = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

async function thumbSave(name, entry) {
  thumbs.set(name, entry);
  const db = await thumbDb();
  if (db) {
    try {
      db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(entry, name);
    } catch (e) {
      /* quota / private mode — keep the in-memory copy */
    }
  }
  const waiter = thumbWaiters.get(name);
  if (waiter) {
    thumbWaiters.delete(name);
    waiter();
  }
}

const hasFreshThumb = (m) => {
  const t = thumbs.get(m.name);
  return !!(t && t.dataUrl && t.v === m.modified);
};

function maybeRequestThumbnail(name, version) {
  const t = thumbs.get(name);
  if (t && t.dataUrl && t.v === version) return;
  thumbPending = { name, version, framesLeft: 2 }; // capture once the fitted view has been drawn
  invalidate(3);
}

// Must run synchronously right after renderer.render() — the WebGL drawing
// buffer is only guaranteed intact until the current task ends.
function captureThumbnail() {
  const glCanvas = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = THUMB_W;
  c.height = THUMB_H;
  const ctx = c.getContext('2d');
  const sw = glCanvas.width;
  const sh = glCanvas.height;
  const aspect = THUMB_W / THUMB_H;
  let cw = sw;
  let ch = sh;
  if (sw / sh > aspect) cw = Math.round(sh * aspect);
  else ch = Math.round(sw / aspect);
  ctx.drawImage(glCanvas, Math.round((sw - cw) / 2), Math.round((sh - ch) / 2), cw, ch, 0, 0, THUMB_W, THUMB_H); // centre crop
  return c.toDataURL('image/jpeg', 0.82);
}

// Called from the render loop right after a frame was drawn.
function afterFrameDrawn() {
  if (!thumbPending || renderer.xr.isPresenting) return;
  if (--thumbPending.framesLeft > 0) return;
  const { name, version } = thumbPending;
  thumbPending = null;
  try {
    const dataUrl = captureThumbnail();
    thumbSave(name, { v: version, dataUrl, at: Date.now() }).then(() => {
      if (!$('#models-modal').hidden) renderModelList();
    });
  } catch (e) {
    console.warn('Preview capture failed:', e);
    const waiter = thumbWaiters.get(name);
    if (waiter) {
      thumbWaiters.delete(name);
      waiter();
    }
  }
}

// ---- "Generate previews" (explicit, user-initiated, cancellable) ----------
const genState = { running: false, cancel: false };

function loadModelAndCapture(m) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      thumbWaiters.delete(m.name);
      resolve();
    }, 20000); // safety net (e.g. tab hidden → no frames)
    thumbWaiters.set(m.name, () => {
      clearTimeout(timer);
      resolve();
    });
    activeModelName = m.name;
    loadModel(m).then(() => {
      if (loadedModelName !== m.name) {
        // load failed — nothing will be captured
        thumbWaiters.delete(m.name);
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function generateAllPreviews() {
  if (genState.running) return;
  const status = $('#gen-status');
  const text = $('#gen-text');
  const bar = $('#gen-bar');
  const todo = models.filter((m) => !hasFreshThumb(m));
  if (!todo.length) {
    text.textContent = 'All previews are up to date.';
    bar.style.width = '100%';
    status.hidden = false;
    setTimeout(() => (status.hidden = true), 1800);
    return;
  }
  genState.running = true;
  genState.cancel = false;
  $('#gen-previews').disabled = true;
  status.hidden = false;
  const restore = loadedModelName;
  let done = 0;
  for (const m of todo) {
    if (genState.cancel) break;
    text.textContent = `Generating previews ${done + 1} / ${todo.length} — ${m.name}`;
    bar.style.width = `${Math.round((done / todo.length) * 100)}%`;
    await loadModelAndCapture(m);
    done++;
    renderModelList();
  }
  bar.style.width = '100%';
  text.textContent = genState.cancel ? `Stopped after ${done} of ${todo.length}.` : `Done — ${done} preview${done === 1 ? '' : 's'} generated.`;
  setTimeout(() => (status.hidden = true), 2200);
  genState.running = false;
  $('#gen-previews').disabled = false;
  // Put the model the user was looking at back on stage (gallery stays open).
  const back = models.find((m) => m.name === restore);
  if (back && loadedModelName !== back.name) {
    activeModelName = back.name;
    loadModel(back);
    renderModelList();
  }
}

// ---- Gallery rendering -----------------------------------------------------
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
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

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
const SORTERS = {
  name: byName,
  size: (a, b) => a.size - b.size || byName(a, b),
  modified: (a, b) => new Date(a.modified) - new Date(b.modified) || byName(a, b),
  extension: (a, b) => a.extension.localeCompare(b.extension) || byName(a, b),
};

function visibleModels() {
  const q = foldText($('#model-search')?.value || '').trim();
  const dir = gallery.dir === 'desc' ? -1 : 1;
  const sorter = SORTERS[gallery.sort] || byName;
  return models
    .filter((m) => (gallery.format === 'all' || m.extension === gallery.format) && (!q || foldText(m.name).includes(q)))
    .sort((a, b) => sorter(a, b) * dir);
}

function syncGalleryToolbar() {
  document.querySelectorAll('.gallery-toolbar [data-view]').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === gallery.view);
    b.setAttribute('aria-pressed', b.dataset.view === gallery.view ? 'true' : 'false');
  });
  document.querySelectorAll('.gallery-toolbar [data-sort]').forEach((b) => {
    const on = b.dataset.sort === gallery.sort;
    b.classList.toggle('active', on);
    b.textContent = on ? `${b.dataset.label} ${gallery.dir === 'asc' ? '▲' : '▼'}` : b.dataset.label;
  });
  const counts = {};
  for (const m of models) counts[m.extension] = (counts[m.extension] || 0) + 1;
  if (gallery.format !== 'all' && !counts[gallery.format]) gallery.format = 'all';
  const chips = $('#format-chips');
  chips.innerHTML = '';
  const chip = (key, label, n) => {
    const b = el('button', `seg-btn${gallery.format === key ? ' active' : ''}`, `${label} ${n}`);
    b.type = 'button';
    b.dataset.format = key;
    chips.append(b);
  };
  chip('all', 'All', models.length);
  for (const ext of MODEL_EXTENSIONS) if (counts[ext]) chip(ext, ext.toUpperCase(), counts[ext]);
}

function updateGallerySummary(visible) {
  const total = models.reduce((s, m) => s + m.size, 0);
  const withPreview = models.filter(hasFreshThumb).length;
  const parts = [];
  if (models.length) parts.push(visible.length === models.length ? `${models.length} models` : `${visible.length} of ${models.length} shown`);
  if (models.length) parts.push(formatSize(total));
  if (models.length) parts.push(`${withPreview}/${models.length} previews`);
  $('#gallery-summary').textContent = parts.join(' · ');
}

function buildCard(m) {
  const card = el('button', 'model-card');
  card.type = 'button';
  card.setAttribute('role', 'option');
  card.dataset.name = m.name;
  card.title = `${m.name}\n${formatSize(m.size)} · ${new Date(m.modified).toLocaleString()}`;
  const isActive = m.name === activeModelName;
  if (isActive) {
    card.classList.add('active');
    card.setAttribute('aria-selected', 'true');
  }

  const thumb = el('div', 'card-thumb');
  const t = thumbs.get(m.name);
  if (t && t.dataUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = t.dataUrl;
    thumb.append(img);
  } else {
    const ph = el('div', 'ph', m.extension.toUpperCase());
    ph.append(el('small', null, 'no preview yet'));
    thumb.append(ph);
  }
  if (isActive) thumb.append(el('span', 'card-badge', 'Viewing'));

  const body = el('div', 'card-body');
  body.append(el('div', 'card-name', m.name));
  const meta = el('div', 'card-meta');
  meta.append(el('span', 'ext', m.extension), el('span', null, formatSize(m.size)), el('span', null, relTime(m.modified)));
  body.append(meta);

  card.append(thumb, body);
  card.addEventListener('click', () => selectModel(m));
  return card;
}

function renderModelList() {
  const listEl = $('#model-list');
  listEl.className = `model-list ${gallery.view === 'list' ? 'gallery-list' : 'gallery-grid'}`;
  listEl.innerHTML = '';
  syncGalleryToolbar();
  if (!models.length) {
    listEl.appendChild(el('div', 'list-empty', 'No models in ./data'));
    updateGallerySummary([]);
    return;
  }
  const visible = visibleModels();
  if (!visible.length) {
    listEl.appendChild(el('div', 'list-empty', 'No models match the current search / filter.'));
    updateGallerySummary(visible);
    return;
  }
  for (const m of visible) listEl.append(buildCard(m));
  updateGallerySummary(visible);
}

function wireGallery() {
  document.querySelectorAll('.gallery-toolbar [data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      gallery.view = b.dataset.view;
      saveGallery();
      renderModelList();
    })
  );
  document.querySelectorAll('.gallery-toolbar [data-sort]').forEach((b) =>
    b.addEventListener('click', () => {
      if (gallery.sort === b.dataset.sort) gallery.dir = gallery.dir === 'asc' ? 'desc' : 'asc';
      else {
        gallery.sort = b.dataset.sort;
        gallery.dir = b.dataset.sort === 'size' || b.dataset.sort === 'modified' ? 'desc' : 'asc';
      }
      saveGallery();
      renderModelList();
    })
  );
  $('#format-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (!b) return;
    gallery.format = b.dataset.format;
    saveGallery();
    renderModelList();
  });
  $('#gen-previews').addEventListener('click', generateAllPreviews);
  $('#gen-cancel').addEventListener('click', () => {
    genState.cancel = true;
  });
  // Arrow keys move between cards (Enter/Space activate the focused card natively).
  $('#model-list').addEventListener('keydown', (e) => {
    const listEl = $('#model-list');
    const cards = [...listEl.querySelectorAll('.model-card')];
    const i = cards.indexOf(document.activeElement);
    if (i < 0 || !cards.length) return;
    const cols = gallery.view === 'list' ? 1 : Math.max(1, Math.round(listEl.clientWidth / (cards[0].offsetWidth + 10)));
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const j = clamp(i + delta, 0, cards.length - 1);
    cards[j].focus();
    cards[j].scrollIntoView({ block: 'nearest' });
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function selectModel(model) {
  activeModelName = model.name;
  setUrlModel(model.name);
  // Reset model-specific transform; keep global lighting/environment settings.
  Object.assign(settings.transform, DEFAULT_TRANSFORM); // mutate in place — controls hold a ref to this object
  ar.yaw = 0;
  ar.scaleMul = 1;
  ar.placed = false;
  refreshAllControls();
  renderModelList();
  closeModels();
  loadModel(model);
}

// ===========================================================================
// Loading / error / empty UI
// ===========================================================================
function setLoading(on, text) {
  const l = $('#loading');
  if (text) $('#loading-text').textContent = text;
  l.hidden = !on;
}
function showError(msg) {
  $('#error-text').textContent = msg;
  $('#error-banner').hidden = false;
}
function clearError() {
  $('#error-banner').hidden = true;
}
function showEmpty(title, sub) {
  const e = $('#empty-state');
  e.querySelector('.overlay-text').textContent = title || 'No model selected';
  e.querySelector('.muted').textContent = sub || 'Open Models to pick one, or drop a USD file here.';
  e.hidden = false;
}
function hideEmpty() {
  $('#empty-state').hidden = true;
}
function setCurrentModelName(name) {
  $('#current-model').textContent = name;
}

// ===========================================================================
// WebXR AR
// ===========================================================================
const ar = {
  active: false,
  hitTestSource: null,
  reticleVisible: false,
  placed: false,
  yaw: 0,
  scaleMul: 1,
  lightProbe: null,
  placePos: new Vector3(),
  placeQuat: new Quaternion(),
};
const _yawQuat = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);
const _s = new Vector3();

function setupARButton() {
  const holder = $('#ar-button-holder');
  const arOverlay = $('#ar-overlay');
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'light-estimation', 'local-floor'],
    domOverlay: { root: arOverlay },
  };
  const btn = ARButton.createButton(renderer, sessionInit);
  holder.appendChild(btn);

  renderer.xr.addEventListener('sessionstart', onXRStart);
  renderer.xr.addEventListener('sessionend', onXREnd);

  const controlsEl = $('#ar-controls');
  // Tapping an overlay button must not also count as an XR "select" (which
  // would re-place the model at the reticle every time you press "+").
  controlsEl.addEventListener('beforexrselect', (e) => e.preventDefault());
  controlsEl.querySelectorAll('[data-ar]').forEach((b) => {
    b.addEventListener('click', () => handleARAction(b.dataset.ar));
  });
}

function onXRStart() {
  const session = renderer.xr.getSession();
  ar.active = true;
  ar.placed = false;
  ar.hitTestSource = null;
  ar.lightProbe = null;
  ar.reticleVisible = false;
  controls.enabled = false;

  // Quest-friendly rendering: fixed-foveation reduces peripheral shading cost;
  // native framebuffer scale keeps the centered model crisp. Guarded because
  // these APIs are only present on XR-capable renderers.
  try {
    renderer.xr.setFoveation?.(1.0);
    renderer.xr.setFramebufferScaleFactor?.(1.0);
  } catch (e) {
    /* ignore — non-XR renderer */
  }
  scene.background = null; // passthrough
  groundMesh.visible = false;
  modelContainer.visible = false; // hidden until placed

  session.requestReferenceSpace('viewer').then((viewerSpace) => {
    if (session.requestHitTestSource) {
      session
        .requestHitTestSource({ space: viewerSpace })
        .then((src) => {
          ar.hitTestSource = src;
        })
        .catch((e) => {
          console.warn('hit-test unavailable:', e);
          updateARStatus('Surface detection (hit-test) is unavailable on this device');
        });
    }
  });

  // Optional light estimation — never required.
  try {
    const enabled = session.enabledFeatures;
    if (session.requestLightProbe && (!enabled || enabled.includes('light-estimation'))) {
      session.requestLightProbe().then((p) => { ar.lightProbe = p; }).catch(() => {});
    }
  } catch (e) {
    /* ignore */
  }

  session.addEventListener('select', onARSelect);
  applyARLighting();
  updateARStatus(currentInner ? 'Point at a surface, then select to place' : 'No model loaded — exit AR and pick a model first');
}

function onXREnd() {
  ar.active = false;
  controls.enabled = true;
  modelContainer.visible = true;
  if (ar.hitTestSource) {
    ar.hitTestSource.cancel?.();
    ar.hitTestSource = null;
  }
  ar.lightProbe = null;
  reticle.visible = false;
  applyEnvironment(); // restore background from settings
  applyGround();
  applyTransform(); // restore desktop transform
  applyLighting(); // restore desktop light intensities
}

function onARSelect() {
  if (!ar.reticleVisible || !currentInner) return;
  reticle.matrix.decompose(ar.placePos, ar.placeQuat, _s);
  ar.placed = true;
  modelContainer.visible = true;
  applyARPlacement();
  updateARStatus('Placed · select again to move · buttons scale / rotate');
}

function applyARPlacement() {
  modelContainer.position.copy(ar.placePos);
  _yawQuat.setFromAxisAngle(_yAxis, ar.yaw);
  modelContainer.quaternion.copy(ar.placeQuat).multiply(_yawQuat);
  const s = settings.transform.scale * ar.scaleMul;
  modelContainer.scale.setScalar(s);
  updateModelDependents();
}

function handleARAction(action) {
  switch (action) {
    case 'scale-up':
      ar.scaleMul *= 1.25;
      break;
    case 'scale-down':
      ar.scaleMul /= 1.25;
      break;
    case 'rotate':
      ar.yaw += Math.PI / 8;
      break;
    case 'reset':
      ar.scaleMul = 1;
      ar.yaw = 0;
      if (ar.reticleVisible) reticle.matrix.decompose(ar.placePos, ar.placeQuat, _s); // snap back to the surface you're looking at
      break;
    case 'anim':
      setPlaying(!anim.playing);
      return;
    case 'exit':
      renderer.xr.getSession()?.end();
      return;
  }
  ar.scaleMul = clamp(ar.scaleMul, 0.05, 40);
  if (ar.placed) applyARPlacement();
  else updateARStatus('Select a surface first to place the model');
}

function applyARLighting() {
  const m = AR_LIGHTING[settings.ar.lighting] || AR_LIGHTING.neutral;
  hemi.visible = settings.ambient.enabled;
  hemi.intensity = settings.ambient.intensity * m.ambient;
  keyLight.visible = settings.key.enabled;
  keyLight.intensity = settings.key.intensity * m.key;
}

function applyLightEstimate(estimate) {
  const p = estimate.primaryLightIntensity;
  if (!p) return;
  const lum = 0.2126 * p.x + 0.7152 * p.y + 0.0722 * p.z;
  // Best-effort mapping; clamped to a sane range.
  keyLight.intensity = clamp(lum, 0.2, 4);
}

function updateARStatus(text) {
  const s = $('#ar-status');
  if (s) s.textContent = text;
}

function updateAR(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (ar.hitTestSource && refSpace) {
    const results = frame.getHitTestResults(ar.hitTestSource);
    if (results.length > 0) {
      const pose = results[0].getPose(refSpace);
      if (pose) {
        reticle.visible = true;
        ar.reticleVisible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
      }
    } else {
      reticle.visible = false;
      ar.reticleVisible = false;
    }
  }
  if (ar.lightProbe && settings.ar.lighting === 'auto' && frame.getLightEstimate) {
    try {
      const est = frame.getLightEstimate(ar.lightProbe);
      if (est) applyLightEstimate(est);
    } catch (e) {
      /* ignore */
    }
  }
}

// ===========================================================================
// Render loop & resize
// ===========================================================================
// Match the drawing buffer to the canvas's *displayed* size. CSS sizes the
// canvas to 100% of its holder, so canvas.clientWidth/Height is the source of
// truth. Running this every frame corrects any resize the browser didn't fire
// an event for (e.g. the pane resized while hidden) — no stale size, no clip.
function resizeToDisplay() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return false;
  const pr = renderer.getPixelRatio();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setSize(w, h, false); // false = leave the canvas style to CSS
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return true;
  }
  return false;
}

// Render on demand. The animation loop keeps ticking (WebXR requires it), but
// the scene is only drawn when something changed — camera motion, a setting,
// a model swap, a resize. Idle frames cost nothing, which matters for battery
// on Quest and phones. In an XR session every frame is drawn.
function render(time, frame) {
  tickAnimation(frameDelta(time));
  if (renderer.xr.isPresenting) {
    if (frame) updateAR(frame);
    renderer.render(scene, camera);
    return;
  }
  if (resizeToDisplay()) invalidate();
  if (controls.update()) invalidate(2); // true while dragging or while damping is still settling
  if (framesToRender <= 0) return;
  framesToRender--;
  renderer.render(scene, camera);
  afterFrameDrawn();
}
renderer.setAnimationLoop(render);

// GPU resets (common on standalone headsets): three restores the context, but
// with render-on-demand nothing would redraw until something changed.
renderer.domElement.addEventListener('webglcontextlost', () => {
  showError('Graphics context lost — waiting for the GPU to recover…');
});
renderer.domElement.addEventListener('webglcontextrestored', () => {
  clearError();
  // Render-target textures (the generated environment map) do not survive a
  // context loss and three cannot re-upload them, so rebuild the IBL; every
  // other resource (geometry, image textures, shadow map) is re-created by three.
  const oldEnv = scene.environment;
  const gen = new PMREMGenerator(renderer);
  scene.environment = gen.fromScene(new RoomEnvironment(), 0.04).texture;
  gen.dispose();
  if (oldEnv) oldEnv.dispose();
  _shadowsWereEnabled = null; // force shader/shadow-map refresh on the new context
  applyShadows();
  applyPerformance(); // re-create the drawing buffer at the right size / pixel ratio
  invalidate(3);
});

// OrbitControls applies wheel-zoom and keyboard pans inside its own handlers
// (it calls update() itself), so the loop's update() sees nothing — the
// controls' `change` event is the reliable "camera moved" signal.
controls.addEventListener('change', () => invalidate(2));

// The render loop is the source of truth; these just nudge an immediate
// correction so a rapid drag-resize or a tab switch doesn't show stale pixels.
window.addEventListener('resize', () => applyPerformance()); // also re-applies the pixel-ratio cap after a devicePixelRatio change
document.addEventListener('visibilitychange', () => {
  _lastFrameTime = 0; // don't count the hidden time as one frame
  invalidate();
});
window.addEventListener('focus', () => invalidate());

// ===========================================================================
// Chrome wiring (model modal, mobile settings drawer, shortcuts, drag & drop)
// ===========================================================================
// Settings live in an always-visible left sidebar on desktop; model selection
// is a modal. On narrow screens the settings become a bottom sheet toggled from
// the topbar, and the canvas shrinks above it so the model re-centers and stays
// visible while sliders are dragged.
function openModels() {
  $('#models-modal').hidden = false;
  renderModelList(); // pick up previews captured while the dialog was closed
  const search = $('#model-search');
  // Only auto-focus with a real keyboard — on touch/Quest it would pop the OSK.
  if (search && window.matchMedia('(pointer: fine)').matches) {
    search.focus();
    search.select();
  }
}
function closeModels() {
  $('#models-modal').hidden = true;
}
function toggleSettings() {
  const p = $('#settings-panel');
  const willOpen = !p.classList.contains('open');
  p.classList.toggle('open', willOpen);
  $('#app').classList.toggle('settings-open', willOpen); // mobile: canvas shrinks above the sheet
}
function closeSettingsDrawer() {
  $('#settings-panel').classList.remove('open');
  $('#app').classList.remove('settings-open');
}

function wireDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  canvasHolder.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    canvasHolder.classList.add('drop-active');
  });
  canvasHolder.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  canvasHolder.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) canvasHolder.classList.remove('drop-active');
  });
  canvasHolder.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    canvasHolder.classList.remove('drop-active');
    const file = e.dataTransfer.files?.[0];
    if (file) loadLocalFile(file);
  });
  // Dropping anywhere else on the page must not navigate away from the app.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

function wireChrome() {
  // Model selection modal
  $('#models-btn').addEventListener('click', openModels);
  const cur = $('#current-model');
  cur.addEventListener('click', openModels);
  cur.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModels();
    }
  });
  $('#models-close').addEventListener('click', closeModels);
  $('#models-modal').querySelector('.modal-backdrop').addEventListener('click', closeModels);
  $('#refresh-btn').addEventListener('click', () => fetchModels());
  $('#model-search').addEventListener('input', renderModelList);

  // Settings
  $('#reset-settings-btn').addEventListener('click', resetAllSettings);
  $('#settings-toggle').addEventListener('click', toggleSettings);
  $('#settings-close').addEventListener('click', closeSettingsDrawer);

  // Errors
  $('#error-close').addEventListener('click', clearError);

  // Viewer shortcuts: double-click or F fits the camera to the model.
  renderer.domElement.addEventListener('dblclick', () => fitCameraToObject(modelContainer));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModels();
      closeSettingsDrawer();
      closeShare();
      return;
    }
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') fitCameraToObject(modelContainer);
    // Space toggles playback (a focused <button> already handles Space itself).
    if (e.code === 'Space' && anim.action && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      setPlaying(!anim.playing);
    }
  });

  wireShareAndTransport();
  wireGallery();
  wireDragAndDrop();
}

// ===========================================================================
// Init
// ===========================================================================
buildSettingsUI();
renderModelInfo(null);
persistSections();
wireChrome();
setupARButton();
applyAll();
showEmpty('Loading model list…', 'Hang on a moment.');
thumbLoadAll().finally(() => fetchModels({ autoload: true })); // previews first so cards render with images

// Expose a tiny hook for debugging / automated checks.
window.__viewer = { scene, camera, renderer, settings, anim, gallery, thumbs, loadModel, loadLocalFile, generateAllPreviews, get models() { return models; }, get specs() { return _lastParsedData?.specsByPath || null; } };
