import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { ZONE_COOKIE, asZone, registerZoneReader } from "@/lib/tz";

/**
 * The carrier's clock on the server. Two things, kept apart (src/lib/tz.ts):
 *   - `workspaceTimezone(id)`: the zone stored on the workspace. Anything that counts money or days (aging, a month's totals, a statement week, an export's dates) asks this, never a cookie.
 *   - the zone reader registered below: for showing a time, the request's zone comes from a cookie the desk sets from the workspace at sign-in and whenever Settings changes it, so a sync
 *     formatter can answer without a database read. It is a display setting only.
 */
registerZoneReader(() => {
  try {
    return cookies().get(ZONE_COOKIE)?.value;
  } catch {
    return null; // outside a request
  }
});

const kept = new Map<string, { zone: string; at: number }>();
const KEEP_MS = 60_000;

/** A workspace's own zone. Kept for a minute so a screen that asks several times reads the database once; a change in Settings clears it. */
export async function workspaceTimezone(workspaceId: string): Promise<string> {
  const hit = kept.get(workspaceId);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.zone;
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { timezone: true } });
  const zone = asZone(row?.timezone);
  kept.set(workspaceId, { zone, at: Date.now() });
  return zone;
}

export function forgetWorkspaceTimezone(workspaceId: string): void {
  kept.delete(workspaceId);
}
