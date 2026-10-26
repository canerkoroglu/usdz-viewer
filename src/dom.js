// Minimal DOM helpers.

export const $ = (sel) => document.querySelector(sel);

/** Create an element with an optional class name and text content. */
export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** True if a keyboard event originates from a text-entry control. */
export const isTypingTarget = (e) => !!e.target?.closest?.('input, select, textarea, [contenteditable]');
