"use client";

import React from "react";
import { payLabel, usd } from "@/lib/desk-format";
import { PERCENT_MAX, RATE_CON_BASIS, percentOf } from "@/lib/pay";

type Option = { id: string; name: string; blocker: string | null; busy: string | null; payKind: string | null; payRate: number | null };

const UNIT: Record<string, string> = { cpm: "$ a mile", flat: "$ for the load", hourly: "$ an hour", percent: "% of the rate" };

/**
 * The driver, pay and rate of an assignment. Picking a driver starts the pay from their usual pay (set on the Drivers page); the
 * dispatcher can still change it for this load, and what is saved is what the form shows. Without a usual pay the pay stays as it was.
 * A set amount is a dollar figure for this load; a percent is a share of the rate confirmation's total, shown in dollars as it is typed.
 */
export function AssignFields({ drivers, initial, rateConTotal }: { drivers: Option[]; initial: { driverId: string | null; payKind: string | null; rate: number | null }; rateConTotal?: number | null }) {
  const firstFree = drivers.find((d) => !d.blocker)?.id ?? "";
  const [driverId, setDriverId] = React.useState(initial.driverId ?? firstFree);
  const startsAt = (id: string) => {
    const d = drivers.find((x) => x.id === id);
    return d?.payKind && d.payRate != null ? { kind: d.payKind, rate: d.payRate } : null;
  };
  // With no usual pay to start from the rate is left blank: the dispatcher types it, rather than the form guessing one.
  const first: { kind: string; rate: number | null } = initial.driverId ? { kind: initial.payKind ?? "cpm", rate: initial.rate } : (startsAt(driverId) ?? { kind: "cpm", rate: null });
  const [kind, setKind] = React.useState(first.kind);
  const [rate, setRate] = React.useState(first.rate == null ? "" : String(first.rate));
  const usual = drivers.find((d) => d.id === driverId);
  const usualText = usual?.payKind ? payLabel(usual.payKind, usual.payRate) : null;
  const typed = Number(rate);
  const shareOf = kind === "percent" && rateConTotal != null && rateConTotal > 0 && Number.isFinite(typed) && typed > 0 && typed <= PERCENT_MAX ? percentOf(typed, rateConTotal) : null;

  return (
    <>
      <label className="tl-field">
        Driver
        <select
          name="driverId"
          value={driverId}
          required
          onChange={(e) => {
            setDriverId(e.target.value);
            const next = startsAt(e.target.value);
            if (next) {
              setKind(next.kind);
              setRate(String(next.rate));
            }
          }}>
          {drivers.map((d) => (
            <option key={d.id} value={d.id} disabled={!!d.blocker}>
              {d.name}
              {d.blocker ? ` — ${d.blocker}` : d.busy ? ` — ${d.busy}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field">
        Pay
        <select name="payKind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="cpm">Per mile</option>
          <option value="flat">Set amount</option>
          <option value="percent">Percent of the rate</option>
          <option value="hourly">Hourly</option>
        </select>
      </label>
      <label className="tl-field">
        Rate ({UNIT[kind] ?? "$"})
        <input name="rate" type="number" step="any" min="0.0001" max={kind === "percent" ? PERCENT_MAX : undefined} value={rate} onChange={(e) => setRate(e.target.value)} required style={{ width: 110 }} />
      </label>
      {kind === "percent" ? (
        <span className="tl-sub" style={{ flexBasis: "100%" }}>
          {shareOf != null ? `${usd(shareOf, 2)} on this load's ${usd(rateConTotal ?? 0, 2)}. ` : ""}A percent is taken of {RATE_CON_BASIS}.
        </span>
      ) : null}
      {usualText ? <span className="tl-sub" style={{ flexBasis: "100%" }}>{usual?.name}&apos;s usual pay is {usualText}.</span> : null}
    </>
  );
}
