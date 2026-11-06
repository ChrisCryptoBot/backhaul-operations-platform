import { asSort, pageCount, type SortDir } from "./paging";

/**
 * A list that is already worked out in memory (the KPI's lanes and customers) shown a page at a time, searched and sorted on the server from the address, so a screen never draws hundreds of rows.
 * Pure. `sorters` names the columns the list can sort by and how to read each; a column not named is not sortable here. Rows with no figure sort last whichever way the column goes. Ties keep the list's own order.
 */
export type ListPageOptions<T> = {
  q?: string | null;
  sort?: string | null;
  page?: number;
  pageSize?: number;
  /** What the search reads for a row. */
  text: (row: T) => string;
  sorters: Record<string, (row: T) => number | string | null>;
};

export type ListPage<T> = { rows: T[]; total: number; all: number; page: number; pageSize: number; pages: number; q: string; sort: { key: string; dir: SortDir } | null };

export const LIST_PAGE_SIZE = 50;

export function listPage<T>(rows: readonly T[], o: ListPageOptions<T>): ListPage<T> {
  const pageSize = o.pageSize ?? LIST_PAGE_SIZE;
  const q = (o.q ?? "").trim();
  const needle = q.toLowerCase();
  const found = needle ? rows.filter((r) => o.text(r).toLowerCase().includes(needle)) : [...rows];
  const sort = o.sort ? asSort(o.sort, Object.keys(o.sorters), { key: "", dir: "asc" }) : { key: "", dir: "asc" as SortDir };
  const read = sort.key ? o.sorters[sort.key] : undefined;
  if (read) {
    const sign = sort.dir === "asc" ? 1 : -1;
    const indexed = found.map((r, i) => ({ r, i, v: read(r) }));
    indexed.sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const c = typeof a.v === "string" || typeof b.v === "string" ? String(a.v).localeCompare(String(b.v), "en", { numeric: true }) : a.v - b.v;
      return c === 0 ? a.i - b.i : c * sign;
    });
    found.splice(0, found.length, ...indexed.map((x) => x.r));
  }
  const pages = pageCount(found.length, pageSize);
  const page = Math.min(Math.max(1, o.page ?? 1), pages);
  return { rows: found.slice((page - 1) * pageSize, page * pageSize), total: found.length, all: rows.length, page, pageSize, pages, q, sort: read ? sort : null };
}
