/** Column sorting for the desk's tables. Pure, so the rules can be tested; <DataTableTools> applies them to the rows in the page. */
export type SortDir = "none" | "ascending" | "descending";
export type SortKind = "num" | "text";

/** none, then ascending, then descending, then back to the page's own order. */
export const nextSort = (d: SortDir): SortDir => (d === "none" ? "ascending" : d === "ascending" ? "descending" : "none");

/**
 * What a cell sorts by: the row's own value when it gave one, else the cell's text. A number column reads the first figure in the text
 * ("$1,234.50", "−6.0%", "26.7 days", "4 loads"), with the true minus sign too; a cell with no figure ("—", "no market rate") has no key.
 */
export function sortKey(kind: SortKind, text: string, given?: string | null): number | string | null {
  const raw = (given ?? text).trim();
  if (kind === "num") {
    const m = /[-−]?\s*\$?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(raw);
    if (!m) return null;
    const n = Number.parseFloat(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    return /^[-−]/.test(m[0]) ? -n : n;
  }
  return raw === "" || raw === "—" ? null : raw.toLowerCase();
}

/** Compares two keys in a direction. A missing key goes last whichever way it is sorted. */
export function compareKeys(a: number | string | null, b: number | string | null, dir: Exclude<SortDir, "none">): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const c = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "en", { numeric: true });
  return dir === "ascending" ? c : -c;
}
