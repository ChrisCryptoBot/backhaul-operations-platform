import { dateTime } from "./desk-format";

/**
 * What a driver needs to be allowed to drive a load, and the first thing that is missing. Pure.
 *
 * A card has to be good for the whole trip, not just today: a medical certificate or a CDL that lapses before the delivery means the driver cannot legally finish it (49 CFR 391.41(a)(1),
 * 391.45, 383.23). A driver who runs under their own authority also needs it active and insured for the trip (49 CFR 387.7, 392.9a); the carrier check's own verdict "failed" blocks too.
 * Those last three are only known for a driver who has been checked: a driver nobody checked (a company driver, most of them) is not blocked for it.
 */
export type Clearance = {
  cdlExpiry: Date | null;
  medicalCardExpiry: Date | null;
  /** The certificate of insurance on the driver's own authority (carrier vetting), when there is one. */
  coiExpiresAt?: Date | null;
  /** The carrier check's verdict: unchecked | clear | review | failed. */
  vetStatus?: string | null;
  /** Whether the carrier check found the operating authority active (null: not known). */
  vetAuthorityActive?: boolean | null;
};

const CARDS = (d: Clearance): Array<{ what: string; on: Date | null }> => [
  { what: "CDL", on: d.cdlExpiry },
  { what: "Medical card", on: d.medicalCardExpiry },
  { what: "Insurance certificate", on: d.coiExpiresAt ?? null }
];

/**
 * Why a driver cannot take a load, or null. `now` is when they would be given it; `until`, when given, is when the trip ends (its last delivery window): a card that lapses before then blocks
 * with the date it lapses and the date the trip needs it to. Without `until`, only what has already lapsed blocks (a driver's own page, a list of drivers).
 */
export function driverBlocker(d: Clearance, now = new Date(), until?: Date | null): string | null {
  for (const c of CARDS(d)) if (c.on && c.on.getTime() < now.getTime()) return `${c.what} expired`;
  if (d.vetAuthorityActive === false) return "Operating authority is not active";
  if (d.vetStatus === "failed") return "Failed the carrier check";
  if (until && until.getTime() > now.getTime()) {
    for (const c of CARDS(d)) if (c.on && c.on.getTime() < until.getTime()) return `${c.what} lapses ${dateTime(c.on)}, before the trip ends ${dateTime(until)}`;
  }
  return null;
}

const DAY = 86_400_000;

/** Pure: the first of a driver's cards to lapse within `days` (and has not lapsed yet), or null. */
export function clearanceSoon(d: Clearance, now: Date, days: number): { what: string; on: Date; inDays: number } | null {
  const soon = CARDS(d)
    .filter((c): c is { what: string; on: Date } => c.on != null && c.on.getTime() >= now.getTime() && c.on.getTime() - now.getTime() <= days * DAY)
    .sort((a, b) => a.on.getTime() - b.on.getTime())[0];
  return soon ? { what: soon.what, on: soon.on, inDays: Math.ceil((soon.on.getTime() - now.getTime()) / DAY) } : null;
}
