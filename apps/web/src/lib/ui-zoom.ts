/**
 * The page zoom the desk applies on big screens (terminal.css, --ui-zoom on the root: 1, 1.12 or 1.25). With it, getBoundingClientRect() and the mouse position are in screen pixels, but a
 * `position: fixed` box is placed in the zoomed page's own pixels. Anything that puts a pop-up beside an element from those numbers divides them by this first. PURE of React; returns 1 off the browser.
 */
export function uiZoom(): number {
  if (typeof document === "undefined") return 1;
  const z = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
