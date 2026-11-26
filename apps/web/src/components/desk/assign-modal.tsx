"use client";

import { useRouter } from "next/navigation";
import { tried } from "./kit/tried";
import React from "react";
import { assignFromQueueAction, assignOptionsAction } from "@/app/(desk)/actions";
import { payLabel, usd } from "@/lib/desk-format";
import type { AssignOptions } from "@/server/tl/suggest";
import { AssignFields } from "./assign-fields";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { REASON_LABEL, reasonsFrom, type ReasonNeed } from "@/lib/assign-reasons";

/**
 * Assign a driver without leaving the queue or the planner. The window opens on the best fits (what the load leaves over the cost floor at
 * each driver's usual pay), and below them is the same driver, pay and rate form as on the load page. A driver who is already on a load then
 * is refused until a reason is typed; a lapsed card is refused outright. Nothing is sent to the driver: that stays a separate step.
 */
export function AssignButton({ loadId, loadNumber, compact, label = "Assign" }: { loadId: string; loadNumber: string; compact?: boolean; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const formRef = React.useRef<HTMLFormElement>(null);
  // The fields inside keep what was typed; once the assignment has gone through they are told to forget it.
  const forget = React.useRef<(() => void) | null>(null);
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<AssignOptions | null | undefined>(undefined);
  const [chosen, setChosen] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // The conditions the server said need a reason, each its own box; kept across tries so a box filled in once stays when another is added.
  const [needs, setNeeds] = React.useState<ReasonNeed[]>([]);
  // Asks for the options again (after someone else changed the load), without closing the window.
  const [reloads, setReloads] = React.useState(0);
  // A reload after "someone else changed it" keeps that message on screen; opening the window afresh clears it.
  const keepError = React.useRef(false);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setData(undefined);
    if (!keepError.current) setError(null);
    keepError.current = false;
    setNeeds([]);
    void assignOptionsAction(loadId).then((out) => {
      if (!live) return;
      setData(out);
      setChosen(out?.suggestions[0]?.driverId ?? out?.drivers.find((d) => !d.blocker && !d.busy)?.id ?? out?.drivers[0]?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [open, loadId, reloads]);

  async function go() {
    const f = formRef.current;
    if (!f) return;
    const v = new FormData(f);
    setBusy(true);
    const got = await tried(() =>
      assignFromQueueAction({
        loadId,
        driverId: String(v.get("driverId") ?? ""),
        payKind: String(v.get("payKind") ?? ""),
        rate: String(v.get("rate") ?? ""),
        reasons: reasonsFrom((k) => v.get(k)),
        // What was there when the window opened: someone else's change in between is refused, not written over.
        expected: data?.current ?? null
      })
    );
    setBusy(false);
    if (!got.ok) {
      setError(got.message);
      return;
    }
    const out = got.value;
    if (!out.ok) {
      setError(out.error);
      if (out.code === "reasons_needed" && out.needs) {
        const asked = out.needs;
        setNeeds((was) => [...was.filter((n) => !asked.some((m) => m.code === n.code)), ...asked]);
      }
      // Someone else changed the load: read who has it now, so the window shows the truth before anything else is pressed.
      if (out.code === "stale") {
        keepError.current = true;
        setReloads((n) => n + 1);
      }
      return;
    }
    forget.current?.();
    setOpen(false);
    toast({ text: `${loadNumber} assigned. Send it to the driver when you are ready.`, tone: "ok" });
    router.refresh();
  }

  // The form starts from the chosen driver's usual pay; changing the driver in the form still does the same.
  const chosenOption = data?.drivers.find((d) => d.id === chosen);

  return (
    <>
      <button type="button" className="t-btn sm" onClick={() => setOpen(true)}>
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
                            {s.truckName ? (data.hasTruck ? ` · priced on ${s.truckName}` : ` · priced on ${s.truckName}, which goes on the load`) : ""}
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
            {data.noTimes ? <p className="tl-note warn">No pickup or delivery time on this load yet, so nobody can be checked for another load at the same time. Add the times from the load first if you can.</p> : null}
            {!data.hasTruck ? <p className="tl-note">This load has no truck yet. Each driver is priced on the truck they usually drive, and that truck goes on the load with them.</p> : null}
            <form
              ref={formRef}
              className="as-fields"
              onSubmit={(e) => {
                e.preventDefault();
                void go();
              }}>
              <AssignFields key={chosen} loadId={loadId} drivers={data.drivers} initial={{ driverId: chosen || null, payKind: chosenOption?.payKind ?? null, rate: chosenOption?.payRate ?? null }} rateConTotal={data.rateConTotal}
                draftKey={`assign-queue:${loadId}:${chosen}`}
                forgetRef={forget}
                needs={needs.map((n) => ({ code: n.code, label: REASON_LABEL[n.code], hint: n.message }))}
              />
            </form>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
