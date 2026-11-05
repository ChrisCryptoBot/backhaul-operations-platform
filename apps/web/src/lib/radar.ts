import { usd } from "./desk-format";
import { durationText, idleWaste, sittingText, type Dwell } from "./telematics";

/**
 * The words the radar, the Trucks list and the Trailers list say about a unit: its equipment code, what idling has cost, how long a trailer has sat and what that owes. Pure, so every screen
 * says it the same way and a test can pin it.
 */

const LETTER: Record<string, string> = { dry_van: "V", reefer: "R", flatbed: "F", step_deck: "SD", rgn: "RGN", conestoga: "C", tanker: "T", car_hauler: "CH", power_only: "PO" };

/** "53V": the trailer's length in feet and a letter for what it is. Either part may be missing. */
export function equipmentCode(type: string | null | undefined, lengthFt: number | null | undefined): string {
  const len = lengthFt != null && lengthFt > 0 ? String(Math.round(lengthFt)) : "";
  const kind = type ? (LETTER[type] ?? type.charAt(0).toUpperCase()) : "";
  return `${len}${kind}`;
}

export type IdleLine = { minutes: number; gallons: number; cashLost: number | null };

/** The idle episode in money: how long it has stood with the engine on, the gallons that burned, and what they cost at the fuel price (null with no price). */
export function idleLine(minutes: number, pricePerGallon: number | null): IdleLine {
  const w = idleWaste(minutes / 60, pricePerGallon);
  return { minutes, gallons: w.gallons, cashLost: w.cashLost };
}

/** "IDLING (Stationary 3h 14m) · Burned: 3.2 gal · Cash Lost: −$12.80". With no fuel price the cash is left out rather than guessed. */
export function idleSentence(l: IdleLine): string {
  const parts = [`IDLING (Stationary ${durationText(l.minutes)})`, `Burned: ${l.gallons.toFixed(1)} gal`];
  if (l.cashLost != null) parts.push(`Cash Lost: ${usd(-l.cashLost, 2)}`);
  return parts.join(" · ");
}

/**
 * "SITTING 4.2 DAYS", and when it is past its free time with no reload "SITTING 4.2 DAYS · Dwell Alert: Exceeds 48h free time · Detention Owed: +$165.00". A waived fee reads WAIVED with what it
 * would have been. `freeHours` is the company's free time.
 */
export function dwellSentence(d: Dwell, freeHours: number): string {
  const parts = [`SITTING ${sittingText(d.hours).toUpperCase()}`];
  if (d.alert) parts.push(`Dwell Alert: Exceeds ${freeHours}h free time`);
  if (d.waived && d.computedAmount > 0) parts.push(`Detention WAIVED (was +${usd(d.computedAmount, 2)})`);
  else if (d.overFreeHours > 0 && (d.alert || d.amount > 0)) parts.push(`Detention Owed: +${usd(d.amount, 2)}`);
  return parts.join(" · ");
}
