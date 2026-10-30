import { prisma } from "@/lib/db";

/**
 * Finished answers kept until the data under them moves. A screen that adds up a whole fleet (the KPI, the header's alert counts) is slow to build and cheap to
 * check: whether anything it is built from has changed is read, exactly, as the newest change to a load, a stop, an assignment, a truck, a driver, a trailer or a cost
 * profile plus the number of loads. The first visit after a change pays for the answer; every visit after it, by anyone, is a check that costs a few milliseconds.
 * The caller puts into its key whatever else the answer depends on (the period, the filters, the thresholds, the hour or minute the clock is read at).
 */
export async function dataMark(workspaceId: string): Promise<string> {
  const [m] = await prisma.$queryRaw<Array<{ n: bigint; l: Date | null; s: Date | null; a: Date | null; v: Date | null; d: Date | null; c: Date | null; r: Date | null }>>`
    select (select count(*) from loads where workspace_id = ${workspaceId}) as n,
      (select max(updated_at) from loads where workspace_id = ${workspaceId}) as l,
      (select max(updated_at) from stops) as s,
      (select max(updated_at) from assignments) as a,
      (select max(updated_at) from vehicles where workspace_id = ${workspaceId}) as v,
      (select max(updated_at) from drivers where workspace_id = ${workspaceId}) as d,
      (select max(updated_at) from cost_profiles) as c,
      (select max(updated_at) from trailers where workspace_id = ${workspaceId}) as r`;
  return [m?.n ?? 0, m?.l, m?.s, m?.a, m?.v, m?.d, m?.c, m?.r].map((x) => (x instanceof Date ? x.getTime() : String(x ?? 0))).join(":");
}

/** Which `size`-millisecond stretch of the clock `ms` falls in: the part of a kept answer's key that moves when the clock does. Whole-number arithmetic, as the KPI rules ask. */
export const clockBucket = (ms: number, size: number): number => (ms - (ms % size)) / size;

export function answerCache<T>(max = 40) {
  const kept = new Map<string, { mark: string; value: T }>();
  return {
    /** The kept answer for `key` if the data is as it was, else `compute()`, kept. */
    async remember(key: unknown[], workspaceId: string, compute: () => Promise<T>): Promise<T> {
      // The mark is read first: a change that lands while the answer is being built leaves the kept mark behind the data, so the next visit rebuilds rather than serving it.
      const mark = await dataMark(workspaceId);
      const k = JSON.stringify(key);
      const hit = kept.get(k);
      if (hit && hit.mark === mark) return hit.value;
      const value = await compute();
      if (kept.size >= max) kept.delete(kept.keys().next().value as string);
      kept.set(k, { mark, value });
      return value;
    },
    /** Tests clear it between cases. */
    clear: () => kept.clear()
  };
}
