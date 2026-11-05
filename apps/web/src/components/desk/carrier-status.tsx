import React from "react";
import { carrierIndicators } from "@/lib/carrier-status";

/** The carrier check's facts as small square tags: authority, safety score, and the insurance certificate, each in the tone the rule gives it. The first reasons the check gave are the hover text. */
export function CarrierStatus({ coiExpiresAt, safetyScore, authorityActive, flags, now }: { coiExpiresAt: Date | null; safetyScore: number | null; authorityActive: boolean | null; flags?: string[]; now: Date }) {
  const items = carrierIndicators({ coiExpiresAt, safetyScore, authorityActive }, now);
  if (items.length === 0) return null;
  const why = (flags ?? []).slice(0, 3).join(" ");
  return (
    <span className="cs" style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }} title={why || undefined}>
      {items.map((i) => (
        <span key={i.key} className="t-st" data-tone={i.tone === "muted" ? undefined : i.tone} data-carrier={i.key}>
          {i.text}
        </span>
      ))}
    </span>
  );
}
