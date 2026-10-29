/** Pure: why a driver cannot take a load today, or null. A lapsed CDL or medical card blocks the assignment. */
export function driverBlocker(d: { cdlExpiry: Date | null; medicalCardExpiry: Date | null }, now = new Date()): string | null {
  if (d.cdlExpiry && d.cdlExpiry.getTime() < now.getTime()) return "CDL expired";
  if (d.medicalCardExpiry && d.medicalCardExpiry.getTime() < now.getTime()) return "Medical card expired";
  return null;
}

const DAY = 86_400_000;

/** Pure: the first of a driver's cards to lapse within `days` (and has not lapsed yet), or null. */
export function clearanceSoon(d: { cdlExpiry: Date | null; medicalCardExpiry: Date | null }, now: Date, days: number): { what: string; on: Date; inDays: number } | null {
  const cards: Array<{ what: string; on: Date | null }> = [
    { what: "CDL", on: d.cdlExpiry },
    { what: "Medical card", on: d.medicalCardExpiry }
  ];
  const soon = cards
    .filter((c): c is { what: string; on: Date } => c.on != null && c.on.getTime() >= now.getTime() && c.on.getTime() - now.getTime() <= days * DAY)
    .sort((a, b) => a.on.getTime() - b.on.getTime())[0];
  return soon ? { what: soon.what, on: soon.on, inDays: Math.ceil((soon.on.getTime() - now.getTime()) / DAY) } : null;
}
