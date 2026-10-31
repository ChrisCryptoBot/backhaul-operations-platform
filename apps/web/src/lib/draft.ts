/**
 * What a person has typed into a form and not yet saved is theirs until they change it themselves: leaving for another module, refreshing, or closing the tab does not take it
 * away. Only a save that went through, or "Start over", clears it. This is the storage half of that rule (the hook that uses it is components/desk/kit/use-draft.tsx, and
 * tests/forms-keep-fields.test.ts fails for any form in the desk that does not).
 *
 * Pure: the browser's storage is passed in, so this runs, and is tested, with a stand-in.
 */

export const DRAFT_PREFIX = "tl-draft:v1:";
/** A draft bigger than this is not kept (storage is a few megabytes, and a form that big holds a file, which cannot be kept anyway). */
export const MAX_DRAFT_CHARS = 400_000;

export type DraftRecord<T> = { v: T; /** The form's own starting values when this was written, to tell if the record has changed since. */ base: string; at: number };

type Storage_ = Pick<Storage, "getItem" | "setItem" | "removeItem"> & { key(i: number): string | null; readonly length: number };

export const draftStorageKey = (scope: string, key: string) => `${DRAFT_PREFIX}${scope}:${key}`;

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Two values are the same form state when they serialise the same: what a form holds is plain data. */
export const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The kept entries laid over the form's own starting values, so a field added since the draft was written has its default and not nothing. Kept entries of a different kind from the
 * form's (a form that has changed shape) are not used.
 */
export function mergeDraft<T>(initial: T, stored: unknown): T {
  if (isPlain(initial)) return isPlain(stored) ? ({ ...initial, ...stored } as T) : initial;
  if (Array.isArray(initial)) return Array.isArray(stored) ? (stored as T) : initial;
  return typeof stored === typeof initial ? (stored as T) : initial;
}

/**
 * Drafts in the browser's own storage, with a copy in memory so that a browser that refuses storage (a private window, a full disk) still keeps them from one page to the next
 * until the tab is closed. Nothing here throws.
 */
export class DraftStore {
  private memory = new Map<string, string>();
  constructor(private storage: Storage_ | null) {}

  get<T>(k: string): DraftRecord<T> | null {
    let raw: string | null = null;
    try {
      raw = this.storage?.getItem(k) ?? null;
    } catch {
      raw = null;
    }
    raw ??= this.memory.get(k) ?? null;
    if (raw == null) return null;
    try {
      const rec = JSON.parse(raw) as DraftRecord<T>;
      return rec && typeof rec === "object" && "v" in rec ? rec : null;
    } catch {
      return null;
    }
  }

  put<T>(k: string, rec: DraftRecord<T>): boolean {
    const raw = JSON.stringify(rec);
    if (raw.length > MAX_DRAFT_CHARS) return false;
    this.memory.set(k, raw);
    try {
      this.storage?.setItem(k, raw);
    } catch {
      /* full or blocked: the copy in memory still covers moving between pages */
    }
    return true;
  }

  drop(k: string): void {
    this.memory.delete(k);
    try {
      this.storage?.removeItem(k);
    } catch {
      /* nothing to do */
    }
  }

  /** Every key that starts with this prefix (a person's drafts, or one form's). */
  keys(prefix: string): string[] {
    const out = new Set([...this.memory.keys()].filter((k) => k.startsWith(prefix)));
    try {
      for (let i = 0; this.storage && i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k?.startsWith(prefix)) out.add(k);
      }
    } catch {
      /* the copy in memory is what there is */
    }
    return [...out];
  }
}

// ── Where each module's list and filters were left ───────────────────────────────────────────

export const VIEW_PREFIX = "tl-view:v1:";

/**
 * The part of a module's address that is the person's own choices (search, filter, sort, the conversation open): kept, so the sidebar returns to a module as they left it. Where they
 * were in a long list (`page`) goes back to the first page, because the list under it has moved.
 */
export function rememberedQuery(search: string): string {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  p.delete("page");
  const out = p.toString();
  return out === "" ? "" : `?${out}`;
}
