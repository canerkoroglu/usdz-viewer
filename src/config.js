// Static configuration: storage keys, option tables, defaults and presets.
// Pure data — no DOM or renderer access, so it can be imported anywhere
// (including the Node test-suite).
import { NoToneMapping, NeutralToneMapping, ACESFilmicToneMapping, AgXToneMapping, LoopRepeat, LoopOnce, LoopPingPong } from 'three';

// localStorage keys (versioned so a schema change can start fresh).
export const STORAGE_KEYS = {
  settings: 'usdz-viewer.settings.v1',
  sections: 'usdz-viewer.sections.v1',
  gallery: 'usdz-viewer.gallery.v1',
  playback: 'usdz-viewer.playback.v1',
};

export const MODEL_EXTENSIONS = ['usd', 'usda', 'usdc', 'usdz'];

// Resource limits for files parsed in the browser (drag & drop, USDZ archives).
// They keep a hostile or broken file from exhausting tab memory: a USDZ is a
// zip, so its declared uncompressed sizes are checked before inflating.
export const MAX_LOCAL_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const USDZ_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxEntryBytes: 512 * 1024 * 1024, // 512 MiB per file inside the archive
  maxTotalBytes: 1536 * 1024 * 1024, // 1.5 GiB uncompressed in total
});

export const TONE_MAPPING = {
  none: { label: 'None', value: NoToneMapping },
  neutral: { label: 'Neutral', value: NeutralToneMapping },
  aces: { label: 'ACES Filmic', value: ACESFilmicToneMapping },
  agx: { label: 'AgX', value: AgXToneMapping },
};

export const SHADOW_QUALITY = {
  low: { label: 'Low', size: 512 },
  medium: { label: 'Medium', size: 1024 },
  high: { label: 'High', size: 2048 },
};

// Performance preset controls render resolution (device-pixel-ratio cap).
export const PERF_QUALITY = {
  low: { label: 'Low', pixelRatio: 1.0 },
  medium: { label: 'Medium', pixelRatio: 1.5 },
  high: { label: 'High', pixelRatio: 2.0 },
};

// AR lighting modes scale the viewer lights while in passthrough AR.
export const AR_LIGHTING = {
  auto: { label: 'Auto', ambient: 1.0, key: 1.0 },
  soft: { label: 'Soft', ambient: 1.4, key: 0.6 },
  neutral: { label: 'Neutral', ambient: 1.0, key: 1.0 },
  strong: { label: 'Strong', ambient: 0.7, key: 1.6 },
};

export const LOOP_MODES = { repeat: LoopRepeat, once: LoopOnce, pingpong: LoopPingPong };

export const DEFAULT_TRANSFORM = Object.freeze({ px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, scale: 1 });

// Quest-friendly defaults: one shadow-casting key light, fill/point off,
// medium shadow map. `preset` is informational ('default' | 'custom' | name).
// Always structuredClone() this before use — it is shared, never mutated.
export const DEFAULT_SETTINGS = Object.freeze({
  preset: 'default',
  env: { background: '#12151c', exposure: 1.0, toneMapping: 'neutral', envIntensity: 1.0 },
  ambient: { enabled: true, intensity: 0.6, sky: '#bfd3ff', ground: '#20242c' },
  key: { enabled: true, intensity: 2.4, x: 3, y: 5, z: 2, color: '#ffffff' },
  fill: { enabled: false, intensity: 0.7, x: -4, y: 2, z: 3, color: '#ffffff' },
  point: { enabled: false, intensity: 8, x: 0, y: 3, z: 0, distance: 0, decay: 2, color: '#ffffff' },
  shadow: { enabled: true, quality: 'medium', bias: -0.0005, normalBias: 0.02 },
  ground: { enabled: true, opacity: 0.5, size: 8, color: '#000000', receive: true },
  transform: { ...DEFAULT_TRANSFORM },
  performance: { quality: 'medium' },
  ar: { lighting: 'auto' },
});

// Lighting presets patch the relevant subsections and are applied instantly.
export const LIGHTING_PRESETS = {
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

// A variant set whose name looks like an animation/clip selector is driven by
// the AnimationMixer rather than a full re-parse (three loads every clip
// regardless of the variant selection, so re-composing changes nothing).
export const ANIM_SET_RE = /anim|clip|action|take|motion/i;
