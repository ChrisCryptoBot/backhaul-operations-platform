/**
 * Which of a quarter's mileage rows count for each truck (money plan Wave 5 step 5b): ELD first, always. A truck with any ELD rows uses ELD rows only (from the one ELD read most recently, if
 * two companies ever reported it); a truck with none uses its routed rows. Pure, and the one rule every reader goes through (the summary today, the return in step 6, the audit in step 7), so
 * reading the ELD after routing a truck can never count it twice, whatever order the two were run in.
 */
export type IftaMethod = "eld" | "routed";
export const isIftaMethod = (m: unknown): m is IftaMethod => m === "eld" || m === "routed";

export type MileageGroup = { vehicleId: string; method: string; source: string; syncedAt: Date | null };

/** Each truck's counted method and source. */
export function countedSource(groups: readonly MileageGroup[]): Map<string, { method: IftaMethod; source: string }> {
  const best = new Map<string, MileageGroup>();
  const rank = (g: MileageGroup) => (g.method === "eld" ? 1 : 0);
  for (const g of groups) {
    if (!isIftaMethod(g.method)) continue;
    const had = best.get(g.vehicleId);
    if (!had || rank(g) > rank(had) || (rank(g) === rank(had) && (g.syncedAt?.getTime() ?? 0) > (had.syncedAt?.getTime() ?? 0)) || (rank(g) === rank(had) && (g.syncedAt?.getTime() ?? 0) === (had.syncedAt?.getTime() ?? 0) && g.source < had.source)) best.set(g.vehicleId, g);
  }
  return new Map([...best].map(([v, g]) => [v, { method: g.method as IftaMethod, source: g.source }]));
}

/** Only the rows that count: each truck's counted method and source. */
export function countedRows<T extends { vehicleId: string; method: string; source: string }>(rows: readonly T[], chosen: Map<string, { method: IftaMethod; source: string }>): T[] {
  return rows.filter((r) => {
    const c = chosen.get(r.vehicleId);
    return c != null && c.method === r.method && c.source === r.source;
  });
}
