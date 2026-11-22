/**
 * The HOS read mirror (Wallet + Bridge plan, Phase 2 step 4), pure: the driver-safe row the desk writes to the phone project's `bridge.driver_status` after it reads its ELD.
 * The SQL that owns the table is the phone project's `supabase/migrations/20261121000500_bridge_driver_status.sql`; tests read it to keep the two in step.
 *
 * Only the minutes left on the three clocks, the tractor's name and when the ELD was read: never a load, a rate, a location or anything about money. The phone shows it
 * "as of" that time and says it is not the legal log.
 */
export type DriverStatusRow = {
  org_id: string;
  driver_sub: string;
  desk_driver_id: string | null;
  drive_minutes: number | null;
  shift_minutes: number | null;
  cycle_minutes: number | null;
  unit_name: string | null;
  synced_at: string;
};

/** The columns the desk writes (exactly these; a test pins them against the SQL). */
export const DRIVER_STATUS_COLUMNS = ["org_id", "driver_sub", "desk_driver_id", "drive_minutes", "shift_minutes", "cycle_minutes", "unit_name", "synced_at"] as const;

const minutes = (v: number | null | undefined, max: number): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const m = Math.round(v);
  return m < 0 ? 0 : m > max ? max : m;
};

/** A driver's row, or null when there is nothing to mirror (not on the phone link, or the ELD has never been read for them). */
export function toStatusRow(
  orgId: string,
  d: { id: string; phoneUserId: string | null; hosDriveMinutes: number | null; hosShiftMinutes: number | null; hosCycleMinutes: number | null; hosSyncedAt: Date | null; unitName: string | null }
): DriverStatusRow | null {
  if (!d.phoneUserId || !d.hosSyncedAt) return null;
  return {
    org_id: orgId,
    driver_sub: d.phoneUserId,
    desk_driver_id: d.id,
    drive_minutes: minutes(d.hosDriveMinutes, 1440),
    shift_minutes: minutes(d.hosShiftMinutes, 1440),
    cycle_minutes: minutes(d.hosCycleMinutes, 10080),
    unit_name: d.unitName ? d.unitName.slice(0, 60) : null,
    synced_at: d.hosSyncedAt.toISOString()
  };
}

type Comparable = Pick<DriverStatusRow, "driver_sub" | "drive_minutes" | "shift_minutes" | "cycle_minutes" | "unit_name" | "synced_at">;

/**
 * What to write and what to remove, given what the bridge already has for this fleet: a row is written only when something in it changed (so the cron does not rewrite every
 * driver every minute), and a row whose driver is no longer connected (or no longer on this desk) is removed.
 */
export function statusPlan(next: readonly DriverStatusRow[], there: readonly Comparable[]): { write: DriverStatusRow[]; remove: string[] } {
  const have = new Map(there.map((r) => [r.driver_sub, r]));
  const same = (a: Comparable, b: Comparable) =>
    a.drive_minutes === b.drive_minutes && a.shift_minutes === b.shift_minutes && a.cycle_minutes === b.cycle_minutes && (a.unit_name ?? null) === (b.unit_name ?? null) && Date.parse(a.synced_at) === Date.parse(b.synced_at);
  const write = next.filter((r) => {
    const h = have.get(r.driver_sub);
    return !h || !same(r, h);
  });
  const keep = new Set(next.map((r) => r.driver_sub));
  const remove = there.map((r) => r.driver_sub).filter((s) => !keep.has(s));
  return { write, remove };
}
