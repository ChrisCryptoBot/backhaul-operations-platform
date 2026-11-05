/**
 * What to show beside a carrier whose check has been run (the Highway-style answer the desk keeps on the driver): whether the operating authority is active, the safety score and how
 * soon the insurance certificate lapses, each with a tone. Pure, so the screen and the tests say the same thing. The lines mirror the rule in server/partners/adapters/highway.ts
 * (a score under 60 or a certificate within 30 days is a reason to look, a lapsed one or an inactive authority is a failure).
 */
export type Tone = "ok" | "warn" | "bad" | "muted";
export type CarrierIndicator = { key: "authority" | "safety" | "insurance"; tone: Tone; text: string };

export const COI_WARN_DAYS = 30;
export const SAFETY_LOW = 60;
export const SAFETY_GOOD = 75;

const DAY = 86_400_000;
const shortDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function carrierIndicators(
  c: { coiExpiresAt: Date | string | null; safetyScore: number | null; authorityActive: boolean | null },
  now: Date
): CarrierIndicator[] {
  const out: CarrierIndicator[] = [];
  if (c.authorityActive === true) out.push({ key: "authority", tone: "ok", text: "Authority active" });
  else if (c.authorityActive === false) out.push({ key: "authority", tone: "bad", text: "Authority not active" });
  if (c.safetyScore != null) out.push({ key: "safety", tone: c.safetyScore < SAFETY_LOW ? "bad" : c.safetyScore < SAFETY_GOOD ? "warn" : "ok", text: `Safety ${c.safetyScore}` });
  if (c.coiExpiresAt) {
    const when = c.coiExpiresAt instanceof Date ? c.coiExpiresAt : new Date(c.coiExpiresAt);
    if (!Number.isNaN(when.getTime())) {
      // A certificate is good through the end of the day it names.
      const left = when.getTime() + DAY - now.getTime();
      const days = Math.max(0, Math.ceil(left / DAY));
      if (left <= 0) out.push({ key: "insurance", tone: "bad", text: `Insurance lapsed ${shortDay(when)}` });
      else if (days <= COI_WARN_DAYS) out.push({ key: "insurance", tone: "warn", text: `Insurance lapses in ${days} ${days === 1 ? "day" : "days"}` });
      else out.push({ key: "insurance", tone: "ok", text: `Insured to ${shortDay(when)}` });
    }
  }
  return out;
}
