"use client";

import React from "react";
import { payLabel } from "@/lib/desk-format";

type Option = { id: string; name: string; blocker: string | null; busy: string | null; payKind: string | null; payRate: number | null };

/**
 * The driver, pay and rate of an assignment. Picking a driver starts the pay from their usual pay (set on the Drivers page); the
 * dispatcher can still change it for this load, and what is saved is what the form shows. Without a usual pay the pay stays as it was.
 */
export function AssignFields({ drivers, initial }: { drivers: Option[]; initial: { driverId: string | null; payKind: string | null; rate: number | null } }) {
  const firstFree = drivers.find((d) => !d.blocker)?.id ?? "";
  const [driverId, setDriverId] = React.useState(initial.driverId ?? firstFree);
  const startsAt = (id: string) => {
    const d = drivers.find((x) => x.id === id);
    return d?.payKind && d.payRate != null ? { kind: d.payKind, rate: d.payRate } : null;
  };
  const first = initial.driverId ? { kind: initial.payKind ?? "cpm", rate: initial.rate ?? 0.65 } : (startsAt(driverId) ?? { kind: "cpm", rate: 0.65 });
  const [kind, setKind] = React.useState(first.kind);
  const [rate, setRate] = React.useState(String(first.rate));
  const usual = drivers.find((d) => d.id === driverId);
  const usualText = usual?.payKind ? payLabel(usual.payKind, usual.payRate) : null;

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
          <option value="flat">Flat</option>
          <option value="hourly">Hourly</option>
        </select>
      </label>
      <label className="tl-field">
        Rate
        <input name="rate" type="number" step="0.01" min="0.01" value={rate} onChange={(e) => setRate(e.target.value)} required style={{ width: 90 }} />
      </label>
      {usualText ? <span className="tl-sub" style={{ flexBasis: "100%" }}>{usual?.name}&apos;s usual pay is {usualText}.</span> : null}
    </>
  );
}
