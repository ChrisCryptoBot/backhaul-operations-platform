/**
 * The "Copy Brief" texts on the Quote terminal. Pure.
 *
 * Three readers, three texts:
 * - `customer`: what goes to the customer in an email. The lane, the times, the load and the offer as the customer made it; none of our figures.
 * - `driver`: a few short lines for a text message to a driver on the road. The trip only: no rate, no pay, no margin.
 * - `dispatch`: the one-liner for the team (Slack and the like). The only text that may carry our truck and our margin.
 *
 * Our own figures reach only the dispatch note: they travel in `internal`, which the other two never read, so a customer or a driver
 * cannot be shown them by a slip in a template.
 */
import { display } from "./date-field";
import { miles, perMile, usd } from "./desk-format";
import { grossPerLoadedMile, type QuoteStop } from "./quote";

export type BriefKind = "customer" | "driver" | "dispatch";

/** The words on the menu. */
export const BRIEF_LABEL: Record<BriefKind, string> = {
  customer: "Customer email",
  driver: "Driver text",
  dispatch: "Dispatch note (internal)"
};

export type BriefInput = {
  stops: QuoteStop[];
  loadedMiles: string;
  weightLbs: string;
  trailer: string;
  offer: string;
  /** The customer's name, as typed. */
  customer: string;
  loadNumber: string;
  poNumber: string;
  /** Our own: the truck chosen and what the load leaves on it. Read by the dispatch note and by nothing else. */
  internal?: { truckName: string; allInPerMile: number | null; marginPerMile: number | null };
};

/** A figure typed in a field ("1,850", " 800 "), or null when it is blank or not a positive number. */
function positive(s: string | null | undefined): number | null {
  const n = Number((s ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

const trailerWords = (trailer: string) => trailer.replace(/_/g, " ").trim();
const clean = (s: string) => s.trim();
const when = (stop: QuoteStop | undefined) => (stop && stop.appointment ? display(stop.appointment, true) : "");

function customerEmail(i: BriefInput): string {
  const stops = i.stops;
  const last = stops.length - 1;
  const lines: string[] = [clean(i.customer) ? `Quote for ${clean(i.customer)}` : "Quote", ""];

  stops.forEach((s, k) => {
    const label = k === 0 ? "Pickup" : k === last ? "Delivery" : `Stop ${k + 1} (${s.role})`;
    const at = when(s);
    lines.push(`${label}: ${clean(s.address) || "TBD"}${at ? `, ${at}` : ""}`);
  });
  if (stops.some((s) => s.appointment)) lines.push("Times are Dallas time.");

  const mi = positive(i.loadedMiles);
  if (mi != null) lines.push(`Loaded miles: ${miles(mi)}`);

  const weight = positive(i.weightLbs);
  const equipment = [weight != null ? `${Math.round(weight).toLocaleString("en-US")} lb` : "", trailerWords(i.trailer)].filter(Boolean).join(" ");
  if (equipment) lines.push(`Equipment: ${equipment}`);

  const offer = positive(i.offer);
  if (offer != null) {
    const gross = grossPerLoadedMile(i.offer, i.loadedMiles);
    lines.push(`Rate: ${usd(offer, Number.isInteger(offer) ? 0 : 2)}${gross != null ? ` (${perMile(gross)} loaded)` : ""}`);
  }

  if (clean(i.loadNumber)) lines.push(`Load #: ${clean(i.loadNumber)}`);
  if (clean(i.poNumber)) lines.push(`PO #: ${clean(i.poNumber)}`);
  return lines.join("\n");
}

function driverText(i: BriefInput): string {
  const stops = i.stops;
  const last = stops.length - 1;
  const origin = clean(stops[0]?.address ?? "") || "Origin";
  const destination = clean(stops[last]?.address ?? "") || "Destination";
  const via = stops
    .slice(1, last)
    .map((s) => clean(s.address))
    .filter(Boolean);
  const mi = positive(i.loadedMiles);
  const lines: string[] = [`${origin} to ${destination}${via.length ? ` via ${via.join(", ")}` : ""}${mi != null ? ` - ${miles(mi)}` : ""}`];

  const pickup = when(stops[0]);
  const delivery = last > 0 ? when(stops[last]) : "";
  const times = [pickup ? `PU ${pickup}` : "", delivery ? `DEL ${delivery}` : ""].filter(Boolean);
  if (times.length) lines.push(`${times.join(", ")} (Dallas time)`);

  const weight = positive(i.weightLbs);
  const shortWeight = weight == null ? "" : weight >= 1000 ? `${Math.round(weight / 1000)}k lb` : `${Math.round(weight)} lb`;
  const bits = [[shortWeight, trailerWords(i.trailer)].filter(Boolean).join(" "), clean(i.loadNumber) ? `Load# ${clean(i.loadNumber)}` : "", clean(i.poNumber) ? `PO ${clean(i.poNumber)}` : ""].filter(Boolean);
  if (bits.length) lines.push(bits.join(" - "));
  return lines.join("\n");
}

/** The one-liner the Copy Brief button has always made, for the team. Kept as it was, so what dispatch pastes into Slack does not change (a loss now reads "-$0.12", not "$-0.12", and a weight typed with a comma is read). */
function dispatchNote(i: BriefInput): string {
  const orig = i.stops[0]?.address || "Origin";
  const dest = i.stops[i.stops.length - 1]?.address || "Destination";
  const mi = i.loadedMiles ? `${i.loadedMiles} mi` : "? mi";
  const weight = Number(i.weightLbs.replace(/,/g, ""));
  const wt = i.weightLbs && Number.isFinite(weight) ? `${Math.round(weight / 1000)}k ` : "";
  const tr = i.trailer ? i.trailer.replace(/_/g, " ") : "Truck";
  const rate = i.offer ? `$${i.offer}` : "Unpriced";
  const row = i.internal;
  const rpm = row?.allInPerMile ? ` ($${row.allInPerMile.toFixed(2)}/mi)` : "";
  const trk = row ? ` · ${row.truckName}` : "";
  const marg = row?.marginPerMile != null ? ` (${row.marginPerMile >= 0 ? "+" : "-"}$${Math.abs(row.marginPerMile).toFixed(2)}/mi)` : "";
  return `${orig} -> ${dest} · ${mi} · ${wt}${tr} · ${rate}${rpm}${trk}${marg}`;
}

export function buildBrief(kind: BriefKind, input: BriefInput): string {
  return kind === "customer" ? customerEmail(input) : kind === "driver" ? driverText(input) : dispatchNote(input);
}
