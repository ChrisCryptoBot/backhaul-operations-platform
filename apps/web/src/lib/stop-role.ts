/**
 * One rule for a stop's role everywhere in the desk and driver bridge (matches server/tl/projector.ts):
 * a stop whose role (or fallback stopType) is "pickup" or "origin" is a pickup; everything else is a delivery.
 */
export function roleOfStop(s: { stopRole?: string | null; stopType: string }): "pickup" | "delivery" {
  const raw = s.stopRole ?? s.stopType;
  return raw === "pickup" || raw === "origin" ? "pickup" : "delivery";
}
