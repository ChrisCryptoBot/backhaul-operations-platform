import { centralMidnight, centralParts } from "./zoned";

/** "2026-10-30" as a real calendar date, or null. */
function dayOf(text: string | undefined): { y: number; m0: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map((x) => Number.parseInt(x, 10)) as [number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const back = centralParts(centralMidnight(y, mo - 1, d));
  return back.y === y && back.m0 === mo - 1 && back.d === d ? { y, m0: mo - 1, d } : null; // rejects 31 Feb and the like
}

/**
 * The audit page's From and To days (both included, read on the Dallas calendar) as a time window: `gte` is midnight Central that morning,
 * `lt` is midnight Central after the To day. A day that is blank or not a real date is ignored; a From after the To is swapped.
 */
export function auditRange(from?: string, to?: string): { gte?: Date; lt?: Date } {
  let a = dayOf(from);
  let b = dayOf(to);
  if (a && b && centralMidnight(a.y, a.m0, a.d) > centralMidnight(b.y, b.m0, b.d)) [a, b] = [b, a];
  return {
    ...(a ? { gte: new Date(centralMidnight(a.y, a.m0, a.d)) } : {}),
    ...(b ? { lt: new Date(centralMidnight(b.y, b.m0, b.d + 1)) } : {})
  };
}
