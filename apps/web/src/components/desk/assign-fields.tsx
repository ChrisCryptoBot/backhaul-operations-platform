"use client";

import React from "react";
import { payLabel, usd } from "@/lib/desk-format";
import { PERCENT_MAX, RATE_CON_BASIS, percentOf } from "@/lib/pay";
import { useDraft } from "./kit/use-draft";
import { useClearOnSuccess } from "./kit/use-submit-outcome";

type Option = { id: string; name: string; blocker: string | null; busy: string | null; payKind: string | null; payRate: number | null; terminal?: string | null };

const UNIT: Record<string, string> = { cpm: "$ a mile", flat: "$ for the load", hourly: "$ an hour", percent: "% of the rate" };

/**
 * The driver, pay and rate of an assignment. Picking a driver starts the pay from their usual pay (set on the Drivers page); the
 * dispatcher can still change it for this load, and what is saved is what the form shows. Without a usual pay the pay stays as it was.
 * A set amount is a dollar figure for this load; a percent is a share of the rate confirmation's total, shown in dollars as it is typed.
 * The list holds the best few drivers (the header's terminal first); "Find another driver" searches everyone, in any terminal, and adds the one chosen to the list.
 */
export function AssignFields({
  drivers: offered,
  loadId,
  initial,
  rateConTotal,
  askOverride = false,
  overrideLabel = "Reason, only for a driver who is already on another load at the same time",
  overridePlaceholder = "For example: team run",
  draftKey,
  forgetRef
}: {
  drivers: Option[];
  loadId: string;
  /** A driver on the list is already on another load at that time, so say why before double-booking them. */
  askOverride?: boolean;
  overrideLabel?: string;
  overridePlaceholder?: string;
  /** What these fields are kept under; one per load by default. A form that restarts them for each suggestion gives each its own. */
  draftKey?: string;
  /** For a form that does not submit the way a page form does: it calls this to forget what was kept, once the assignment has gone through. */
  forgetRef?: React.MutableRefObject<(() => void) | null>;
  initial: { driverId: string | null; payKind: string | null; rate: number | null };
  rateConTotal?: number | null;
}) {
  const [found, setFound] = React.useState<Option[]>([]);
  const [added, setAdded] = React.useState<Option[]>([]);
  const [search, setSearch] = React.useState("");
  const list = React.useId();
  const drivers = [...offered, ...added.filter((a) => !offered.some((o) => o.id === a.id))];
  React.useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch(`/drivers/pick?q=${encodeURIComponent(search.trim())}&load=${encodeURIComponent(loadId)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { drivers: [] }))
        .then((j: { drivers: Option[] }) => setFound(j.drivers))
        .catch(() => undefined);
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [search, loadId]);
  const firstFree = drivers.find((d) => !d.blocker)?.id ?? "";
  const startsAt = (id: string) => {
    const d = drivers.find((x) => x.id === id);
    return d?.payKind && d.payRate != null ? { kind: d.payKind, rate: d.payRate } : null;
  };
  // With no usual pay to start from the rate is left blank: the dispatcher types it, rather than the form guessing one.
  const firstDriver = initial.driverId ?? firstFree;
  const first: { kind: string; rate: number | null } = initial.driverId ? { kind: initial.payKind ?? "cpm", rate: initial.rate } : (startsAt(firstDriver) ?? { kind: "cpm", rate: null });
  // What is typed here is kept until the assignment has gone through (the form around it is the page's, so the field watches it).
  const [{ driverId, kind, rate, overrideReason }, setPick, draft] = useDraft(draftKey ?? `assign:${loadId}`, { driverId: firstDriver, kind: first.kind, rate: first.rate == null ? "" : String(first.rate), overrideReason: "" });
  const setDriverId = (v: string) => setPick((p) => ({ ...p, driverId: v }));
  const setKind = (v: string) => setPick((p) => ({ ...p, kind: v }));
  const setRate = (v: string) => setPick((p) => ({ ...p, rate: v }));
  const setOverrideReason = (v: string) => setPick((p) => ({ ...p, overrideReason: v }));
  const anchor = React.useRef<HTMLSpanElement>(null);
  useClearOnSuccess(anchor, draft);
  React.useEffect(() => {
    if (forgetRef) forgetRef.current = draft.saved;
  });
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
        Find another driver
        <input
          value={search}
          list={list}
          placeholder="Type a name"
          autoComplete="off"
          onChange={(e) => {
            const v = e.target.value;
            setSearch(v);
            const hit = found.find((o) => o.name.toLowerCase() === v.trim().toLowerCase());
            if (!hit) return;
            setAdded((a) => (a.some((x) => x.id === hit.id) ? a : [...a, hit]));
            setDriverId(hit.id);
            if (hit.payKind && hit.payRate != null) {
              setKind(hit.payKind);
              setRate(String(hit.payRate));
            }
            setSearch("");
          }}
        />
        <datalist id={list}>
          {found.map((o) => (
            <option key={o.id} value={o.name} label={[o.terminal, o.blocker ?? o.busy].filter(Boolean).join(" · ") || undefined} />
          ))}
        </datalist>
      </label>
      <label className="tl-field">
        Pay
        <select
          name="payKind"
          value={kind}
          onChange={(e) => {
            // A rate typed for one kind is not a rate for another (25 a percent is not $25 a mile): the box starts again, from the driver's usual pay when that is this kind.
            const usual = startsAt(driverId);
            setKind(e.target.value);
            setRate(usual && usual.kind === e.target.value ? String(usual.rate) : "");
          }}>
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
      {askOverride ? (
        <label className="tl-field" style={{ flexBasis: "100%" }}>
          {overrideLabel}
          <input name="overrideReason" type="text" placeholder={overridePlaceholder} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
        </label>
      ) : null}
      <span ref={anchor} hidden />
    </>
  );
}
