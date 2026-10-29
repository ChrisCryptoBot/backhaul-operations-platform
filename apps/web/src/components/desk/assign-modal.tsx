"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { assignFromQueueAction, assignOptionsAction } from "@/app/(desk)/actions";
import { payLabel, usd } from "@/lib/desk-format";
import type { AssignOptions } from "@/server/tl/suggest";
import { AssignFields } from "./assign-fields";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

/**
 * Assign a driver without leaving the queue or the planner. The window opens on the best fits (what the load leaves over the cost floor at
 * each driver's usual pay), and below them is the same driver, pay and rate form as on the load page. A driver who is already on a load then
 * is refused until a reason is typed; a lapsed card is refused outright. Nothing is sent to the driver: that stays a separate step.
 */
export function AssignButton({ loadId, loadNumber, compact, label = "Assign" }: { loadId: string; loadNumber: string; compact?: boolean; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const formRef = React.useRef<HTMLFormElement>(null);
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<AssignOptions | null | undefined>(undefined);
  const [chosen, setChosen] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setData(undefined);
    setError(null);
    void assignOptionsAction(loadId).then((out) => {
      if (!live) return;
      setData(out);
      setChosen(out?.suggestions[0]?.driverId ?? out?.drivers.find((d) => !d.blocker && !d.busy)?.id ?? out?.drivers[0]?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [open, loadId]);

  async function go() {
    const f = formRef.current;
    if (!f) return;
    const v = new FormData(f);
    setBusy(true);
    const out = await assignFromQueueAction({ loadId, driverId: String(v.get("driverId") ?? ""), payKind: String(v.get("payKind") ?? ""), rate: String(v.get("rate") ?? ""), overrideReason: String(v.get("overrideReason") ?? "") });
    setBusy(false);
    if (!out.ok) {
      setError(out.error);
      return;
    }
    setOpen(false);
    toast({ text: `${loadNumber} assigned. Send it to the driver when you are ready.`, tone: "ok" });
    router.refresh();
  }

  const needsReason = error != null && /reason/i.test(error);
  // The form starts from the chosen driver's usual pay; changing the driver in the form still does the same.
  const chosenOption = data?.drivers.find((d) => d.id === chosen);

  return (
    <>
      <button type="button" className={`tl-btn sm${compact ? " ghost" : ""}`} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Modal
        wide
        open={open}
        onClose={close}
        eyebrow={loadNumber}
        title="Who takes it?"
        footer={
          <>
            {error ? (
              <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>
                {error}
              </span>
            ) : null}
            <button type="button" className="tl-btn" onClick={close}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || !data || chosen === ""} aria-busy={busy || undefined} onClick={() => void go()}>
              {busy ? "Assigning…" : "Assign"}
            </button>
          </>
        }>
        {data === undefined ? <p className="tl-note">Looking at who is free…</p> : null}
        {data === null ? <p className="tl-note warn">That load is gone.</p> : null}
        {data ? (
          <div className="dlg-form">
            <p className="tl-sub">{data.lane}</p>
            {data.suggestions.length > 0 ? (
              <>
                <h3 className="th-group">Best fits</h3>
                <ul className="as-sugs">
                  {data.suggestions.map((s, i) => (
                    <li key={s.driverId}>
                      <button type="button" className="as-sug" aria-pressed={chosen === s.driverId} onClick={() => setChosen(s.driverId)}>
                        <span>
                          <b>{s.name}</b>
                          <span className="tl-sub">
                            {" "}
                            {payLabel(s.payKind, s.payRate)}
                            {s.truckName ? ` · priced on ${s.truckName}` : ""}
                          </span>
                        </span>
                        <span className={s.leftOver == null ? "tl-sub" : s.leftOver >= 0 ? "as-ok" : "as-bad"}>
                          {s.leftOver == null ? "Cannot be priced yet" : s.leftOver >= 0 ? `Leaves ${usd(s.leftOver)}${i === 0 ? ", the most" : ""}` : `Short by ${usd(Math.abs(s.leftOver))}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="tl-note">No driver is free for this load. Pick one below and say why, or change the times.</p>
            )}
            {!data.hasTruck ? <p className="tl-note">This load has no truck yet, so each driver is priced on the truck they usually drive. Set the load&apos;s truck under Edit details for the real figure.</p> : null}
            <form
              ref={formRef}
              className="as-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void go();
              }}>
              <AssignFields key={chosen} drivers={data.drivers} initial={{ driverId: chosen || null, payKind: chosenOption?.payKind ?? null, rate: chosenOption?.payRate ?? null }} rateConTotal={data.rateConTotal} />
              {needsReason ? (
                <label className="tl-field" style={{ flexBasis: "100%" }}>
                  Why double-book this driver?
                  <input name="overrideReason" autoComplete="off" placeholder="A few words, kept in the audit log" />
                </label>
              ) : null}
            </form>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
