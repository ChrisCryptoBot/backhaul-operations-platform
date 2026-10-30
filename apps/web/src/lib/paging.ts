/**
 * Lists that are read a page at a time: the page number and the sort come from the address, so a link is a place and the back button works.
 * Pure, shared by the pages and their tests.
 */
export const asPage = (v: string | undefined | null): number => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 1 ? n : 1;
};

export const pageCount = (total: number, pageSize: number): number => (total <= 0 ? 1 : Math.ceil(total / pageSize));

export type SortDir = "asc" | "desc";

/** A sort from the address ("name" or "-name" for descending), kept only if the column is one the list can sort by. */
export function asSort<K extends string>(v: string | undefined | null, allowed: readonly K[], fallback: { key: K; dir: SortDir }): { key: K; dir: SortDir } {
  const raw = (v ?? "").trim();
  const dir: SortDir = raw.startsWith("-") ? "desc" : "asc";
  const key = raw.replace(/^-/, "") as K;
  return allowed.includes(key) ? { key, dir } : fallback;
}

/** Where a column header goes: sorted ascending, then descending, then back to the list's own order. */
export function nextSortParam(current: { key: string; dir: SortDir } | null, key: string): string | null {
  if (!current || current.key !== key) return key;
  return current.dir === "asc" ? `-${key}` : null;
}
