import { dateTime, payLabel, usd } from "./desk-format";

/**
 * The offer as plain text, for a driver who does not have the app: the dispatcher copies it and pastes it into a text message. Built only from the driver-safe summary
 * (server/tl/projector.ts, checked by assertDriverSafe before it gets here), so it carries what the driver's phone would show and nothing the customer pays. Pure.
 */
type End = { address: string; window_earliest?: string; window_latest?: string; po_number?: string; dock_notes?: string };
export type OfferSummary = {
  /** The first stop and the last: the summary keeps them apart from the stops in between. */
  origin: End | null;
  destination: End | null;
  stops: Array<{ seq: number; type: "pickup" | "delivery"; address: string; window_earliest?: string; window_latest?: string; po_number?: string; dock_notes?: string }>;
  equipment: { trailer_type: string | null };
  driver_pay: { kind: string; rate: number; estimate: number };
  reference: { load_number?: string };
  miles?: { loaded: number };
  weight_lbs?: number;
  dispatcher?: { name: string };
};

const when = (s: { window_earliest?: string; window_latest?: string }, tz?: string): string | null => {
  const a = s.window_earliest ? dateTime(s.window_earliest, tz) : null;
  const b = s.window_latest ? dateTime(s.window_latest, tz) : null;
  return a && b && a !== b ? `${a} to ${b}` : (a ?? b);
};

/** `withPay` false: for someone who may not see driver pay (billing_details), the pay line says it is their usual pay without the figure. */
export function offerText(o: OfferSummary, tz?: string, withPay = true): string {
  const lines: string[] = [];
  lines.push(`Load ${o.reference.load_number ?? ""}`.trim() + (o.dispatcher ? `, from ${o.dispatcher.name}` : ""));
  // In driving order: the first stop (a pickup), any stops in between as the summary orders them, the last stop (a delivery).
  const all: Array<End & { type: "pickup" | "delivery" }> = [
    ...(o.origin ? [{ ...o.origin, type: "pickup" as const }] : []),
    ...[...o.stops].sort((a, b) => a.seq - b.seq),
    ...(o.destination ? [{ ...o.destination, type: "delivery" as const }] : [])
  ];
  all.forEach((s, i) => {
    const at = when(s, tz);
    lines.push(`${i + 1}. ${s.type === "pickup" ? "Pick up" : "Deliver"}: ${s.address}${at ? `, ${at}` : ""}${s.po_number ? ` (ref ${s.po_number})` : ""}`);
    if (s.dock_notes) lines.push(`   ${s.dock_notes}`);
  });
  const what = [o.equipment.trailer_type ? o.equipment.trailer_type.replace(/_/g, " ") : null, o.weight_lbs ? `${o.weight_lbs.toLocaleString("en-US")} lb` : null, o.miles ? `${o.miles.loaded.toLocaleString("en-US")} loaded mi` : null].filter(Boolean);
  if (what.length > 0) lines.push(what.join(" · "));
  lines.push(withPay ? `Your pay: ${payLabel(o.driver_pay.kind, o.driver_pay.rate)}${o.driver_pay.kind === "flat" ? "" : `, about ${usd(o.driver_pay.estimate, 2)}`}` : "Your pay: your usual pay.");
  lines.push("Reply yes to take it, or no and why.");
  return lines.join("\n");
}
