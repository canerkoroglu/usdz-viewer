// localStorage helpers. Storage can be unavailable (private mode, disabled
// site data) or full; persistence is always best-effort and never throws.

/** Read and JSON-parse `key`; returns `fallback` if missing or unreadable. */
export function loadJSON(key, fallback = {}) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}

/** JSON-serialise `value` into `key`; failures are silently ignored. */
export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded / storage disabled — non-fatal */
  }
}
