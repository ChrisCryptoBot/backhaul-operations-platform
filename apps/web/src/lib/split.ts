/**
 * The maths of a draggable split between two panes: keep the first pane's size inside its limits, step it from the keyboard, and read and write what was kept. Pure, so a test can pin it and
 * any screen can use it. `size` is the first pane's size in pixels along the split (width for a left and right split, height for a top and bottom one).
 */
export type SplitLimits = { min: number; max: number };

/** The size held inside the limits (a max below the min gives the min). */
export const clampSize = (size: number, { min, max }: SplitLimits): number => Math.max(min, Math.min(Math.max(min, max), Math.round(size)));

export const KEY_STEP = 24;

/** The size a key press asks for, or null when the key means nothing here. Left and Up make the first pane smaller; Right and Down larger; Home the smallest, End the largest. */
export function stepSize(size: number, key: string, limits: SplitLimits, step = KEY_STEP): number | null {
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return clampSize(size - step, limits);
    case "ArrowRight":
    case "ArrowDown":
      return clampSize(size + step, limits);
    case "Home":
      return limits.min;
    case "End":
      return Math.max(limits.min, limits.max);
    default:
      return null;
  }
}

export type SplitKept = { size: number | null; hidden: boolean };

export const splitStorageKey = (id: string) => `tl_split_${id}`;

/** What was kept for a split: a size (any number is clamped when it is used) and whether the first pane was hidden. Anything else reads as nothing kept. */
export function parseKept(text: string | null | undefined): SplitKept {
  if (!text) return { size: null, hidden: false };
  try {
    const v = JSON.parse(text) as { size?: unknown; hidden?: unknown };
    return { size: typeof v.size === "number" && Number.isFinite(v.size) ? v.size : null, hidden: v.hidden === true };
  } catch {
    return { size: null, hidden: false };
  }
}

export const keptText = (k: SplitKept): string => JSON.stringify({ size: k.size, hidden: k.hidden });
