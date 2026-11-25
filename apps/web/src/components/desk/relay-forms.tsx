"use client";

import { useRouter } from "next/navigation";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import type { InlineActionResult } from "@/app/(desk)/actions";

import React from "react";
import { Modal } from "./kit/modal";
import { useDraft } from "./kit/use-draft";
import { AssignFields } from "./assign-fields";
import { HANDOFF_REASON_LABEL, HANDOFF_REASONS, HANDOFF_TYPES, HANDOFF_TYPE_LABEL, OUTGOING_NEXT, OUTGOING_NEXT_LABEL, type HandoffType } from "@/lib/relay";

/**
 * The relay forms (docs/RELAY_DESIGN.md): a driver leaves the load at a place (the drop), the next driver takes it (the receive), and something found wrong is reported and acknowledged.
 * The dispatcher fills them in for the driver until the phone can. Every form keeps what was typed until it is sent or cancelled.
 */
type Action = (formData: FormData) => Promise<InlineActionResult>;
type Drivers = React.ComponentProps<typeof AssignFields>["drivers"];

const row: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 };

function useSend(action: Action, open: boolean, close: () => void, saved: () => void) {
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const router = useRouter();
  const toast = useToast();
  React.useEffect(() => {
    if (!open) setError(null);
  }, [open]);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    setError(null);
    start(async () => {
      const res = await tried(() => action(data));
      if (!res.ok) {
        setError(res.message);
        return;
      }
      if (!res.value.ok) {
        setError(res.value.error);
        return;
      }
      saved();
      close();
      toast({ text: res.value.message, tone: "ok" });
      router.refresh();
    });
  };
  return { pending, error, onSubmit };
}

const BLANK_DROP = { type: "drop_hook", reason: "planned", locationName: "", slot: "", lat: "", lng: "", outgoingNext: "", sealNumber: "", milesDriven: "", milesSource: "", reeferSetTemp: "", reeferActualTemp: "", reeferFuelPct: "", conditionOk: "", conditionNotes: "" };

/** Hand the load off: the outgoing driver left it at a place. */
export function DropForm({ action, loadId, loadNumber, driverName }: { action: Action; loadId: string; loadNumber: string; driverName: string }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV, draft] = useDraft(`drop:${loadId}`, BLANK_DROP);
  const set = (k: keyof typeof BLANK_DROP) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const { pending, error, onSubmit } = useSend(action, open, () => setOpen(false), () => draft.saved());
  const type = v.type as HandoffType;
  return (
    <>
      <button type="button" className="tl-btn sm" disabled={pending} aria-busy={pending || undefined} onClick={() => setOpen(true)}>
        Hand off to another driver
      </button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="Handoff" title={`${driverName} hands off ${loadNumber}`} wide>
        <form onSubmit={onSubmit}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">The load stays on the road with nobody holding it until the next driver takes it. Fill this in for the driver. Anything you do not know, leave blank: nothing here is guessed.</p>
          <div style={row}>
            <label className="tl-field">Kind
              <select name="type" value={v.type} onChange={set("type")}>
                {HANDOFF_TYPES.map((t) => <option key={t} value={t}>{HANDOFF_TYPE_LABEL[t]}</option>)}
              </select>
            </label>
            <label className="tl-field">Why
              <select name="reason" value={v.reason} onChange={set("reason")}>
                {HANDOFF_REASONS.map((r) => <option key={r} value={r}>{HANDOFF_REASON_LABEL[r]}</option>)}
              </select>
            </label>
          </div>
          <div style={row}>
            <label className="tl-field">Where
              <input name="locationName" type="text" value={v.locationName} onChange={set("locationName")} placeholder="Yard, truck stop or exit" />
            </label>
            <label className="tl-field">Slot or spot
              <input name="slot" type="text" value={v.slot} onChange={set("slot")} placeholder="12" />
            </label>
          </div>
          <div style={row}>
            <label className="tl-field">Latitude (optional)
              <input name="lat" type="number" step="any" value={v.lat} onChange={set("lat")} />
            </label>
            <label className="tl-field">Longitude (optional)
              <input name="lng" type="number" step="any" value={v.lng} onChange={set("lng")} />
            </label>
          </div>
          <label className="tl-field" style={{ marginTop: 10 }}>What the outgoing driver does now
            <select name="outgoingNext" value={v.outgoingNext} onChange={set("outgoingNext")} required>
              <option value="">Pick one</option>
              {OUTGOING_NEXT.map((n) => <option key={n} value={n}>{OUTGOING_NEXT_LABEL[n]}</option>)}
            </select>
          </label>
          <div style={row}>
            <label className="tl-field">Seal number
              <input name="sealNumber" type="text" value={v.sealNumber} onChange={set("sealNumber")} />
            </label>
            <label className="tl-field">Miles they drove (optional)
              <input name="milesDriven" type="number" step="any" min="0" value={v.milesDriven} onChange={set("milesDriven")} />
            </label>
            <label className="tl-field">Where the miles came from
              <select name="milesSource" value={v.milesSource} onChange={set("milesSource")}>
                <option value="">Not entered</option>
                <option value="eld">The ELD</option>
                <option value="driver">The driver</option>
                <option value="dispatcher">I worked it out</option>
              </select>
            </label>
          </div>
          {type !== "slip_seat" ? (
            <div style={row}>
              <label className="tl-field">Reefer set temp
                <input name="reeferSetTemp" type="number" step="any" value={v.reeferSetTemp} onChange={set("reeferSetTemp")} />
              </label>
              <label className="tl-field">Reefer actual temp
                <input name="reeferActualTemp" type="number" step="any" value={v.reeferActualTemp} onChange={set("reeferActualTemp")} />
              </label>
              <label className="tl-field">Reefer fuel %
                <input name="reeferFuelPct" type="number" step="1" min="0" max="100" value={v.reeferFuelPct} onChange={set("reeferFuelPct")} />
              </label>
            </div>
          ) : null}
          <div style={row}>
            <label className="tl-field">Trailer condition as left
              <select name="conditionOk" value={v.conditionOk} onChange={set("conditionOk")}>
                <option value="">Not said</option>
                <option value="yes">Fine</option>
                <option value="no">A problem</option>
              </select>
            </label>
            <label className="tl-field" style={{ flex: 1 }}>Notes
              <input name="conditionNotes" type="text" value={v.conditionNotes} onChange={set("conditionNotes")} />
            </label>
          </div>
          <div style={{ ...row, justifyContent: "flex-end", alignItems: "center" }}>
            {error ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{error}</span> : null}
            <button type="button" className="tl-btn" onClick={() => { draft.discard(); setOpen(false); }}>Cancel</button>
            <button type="submit" className="tl-btn primary" disabled={pending || !v.outgoingNext || (!v.locationName.trim() && !(v.lat && v.lng))}>
              {pending ? "Saving…" : "Record the handoff"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** The next driver takes the load. The driver list and its notes are the ones an assignment uses. */
export function ReceiveForm({
  action,
  loadId,
  handoff,
  drivers,
  trucks,
  rateConTotal,
  blockedByDiscrepancy
}: {
  action: Action;
  loadId: string;
  handoff: { id: string; type: string; locationName: string | null; tractorOutId: string | null; tractorOutName: string | null; sealNumber: string | null };
  drivers: Drivers;
  trucks: Array<{ id: string; name: string }>;
  rateConTotal: number | null;
  blockedByDiscrepancy: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [v, setV, draft] = useDraft(`receive:${handoff.id}`, { vehicleId: "", sealMatches: "", conditionOk: "", conditionNotes: "" });
  const forget = React.useRef<(() => void) | null>(null);
  const { pending, error, onSubmit } = useSend(action, open, () => setOpen(false), () => { draft.saved(); forget.current?.(); });
  const swap = handoff.type === "slip_seat";
  return (
    <>
      <button type="button" className="tl-btn sm primary" disabled={pending || blockedByDiscrepancy} title={blockedByDiscrepancy ? "Acknowledge the reported discrepancy first" : undefined} onClick={() => setOpen(true)}>
        Next driver takes the load
      </button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="Handoff" title={`Take the load at ${handoff.locationName ?? "the handoff"}`} wide>
        <form onSubmit={onSubmit}>
          <input type="hidden" name="loadId" value={loadId} />
          <input type="hidden" name="handoffId" value={handoff.id} />
          <p className="tl-note">The next driver&rsquo;s tap alone transfers the load. {handoff.sealNumber ? `Seal on file: ${handoff.sealNumber}.` : ""}</p>
          <AssignFields drivers={drivers} loadId={loadId} draftKey={`receive-driver:${handoff.id}`} forgetRef={forget} initial={{ driverId: null, payKind: null, rate: null }} rateConTotal={rateConTotal} askOverride overrideLabel="Reason, only if the driver or the truck is already on another load at that time" overridePlaceholder="For example: covering a sick driver" />
          {swap ? (
            <p className="tl-note" style={{ marginTop: 10 }}>A driver swap keeps the same truck{handoff.tractorOutName ? ` (${handoff.tractorOutName})` : ""}.</p>
          ) : (
            <label className="tl-field" style={{ marginTop: 10 }}>Truck taking the trailer
              <select name="vehicleId" value={v.vehicleId} onChange={(e) => setV((x) => ({ ...x, vehicleId: e.target.value }))} required>
                <option value="">Pick a truck</option>
                {trucks.filter((t) => t.id !== handoff.tractorOutId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <div style={row}>
            <label className="tl-field">Seal matches what was recorded
              <select name="sealMatches" value={v.sealMatches} onChange={(e) => setV((x) => ({ ...x, sealMatches: e.target.value }))}>
                <option value="">Not said</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
            <label className="tl-field">Trailer as found
              <select name="conditionOk" value={v.conditionOk} onChange={(e) => setV((x) => ({ ...x, conditionOk: e.target.value }))}>
                <option value="">Not said</option>
                <option value="yes">Fine</option>
                <option value="no">A problem</option>
              </select>
            </label>
            <label className="tl-field" style={{ flex: 1 }}>Notes
              <input name="conditionNotes" type="text" value={v.conditionNotes} onChange={(e) => setV((x) => ({ ...x, conditionNotes: e.target.value }))} />
            </label>
          </div>
          <p className="tl-note" style={{ marginTop: 10 }}>What each leg is paid is not split yet. This driver&rsquo;s pay is kept, but the load carries no estimate for it, and the driver who dropped it keeps their pay as it stood.</p>
          <div style={{ ...row, justifyContent: "flex-end", alignItems: "center" }}>
            {error ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{error}</span> : null}
            <button type="button" className="tl-btn" onClick={() => { draft.discard(); setOpen(false); }}>Cancel</button>
            <button type="submit" className="tl-btn primary" disabled={pending}>
              {pending ? "Saving…" : "Hand the load to them"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Report something wrong at the handoff (a broken seal, damage): the baton is frozen as found. */
export function DiscrepancyForm({ action, loadId, handoffId, location }: { action: Action; loadId: string; handoffId: string; location: string }) {
  const [open, setOpen] = React.useState(false);
  const [v, setV, draft] = useDraft(`discrepancy:${handoffId}`, { notes: "", raisedBy: "incoming_driver" });
  const { pending, error, onSubmit } = useSend(action, open, () => setOpen(false), () => draft.saved());
  return (
    <>
      <button type="button" className="tl-btn sm danger" disabled={pending} onClick={() => setOpen(true)}>Report a problem at the handoff</button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="Handoff" title={`Something is wrong at ${location}`}>
        <form onSubmit={onSubmit}>
          <input type="hidden" name="loadId" value={loadId} />
          <input type="hidden" name="handoffId" value={handoffId} />
          <p className="tl-note">The handoff is frozen as found and nobody can take the load until dispatch acknowledges it. This says what was found, not who is to blame.</p>
          <label className="tl-field" style={{ marginTop: 10 }}>Who found it
            <select name="raisedBy" value={v.raisedBy} onChange={(e) => setV((x) => ({ ...x, raisedBy: e.target.value }))}>
              <option value="incoming_driver">The incoming driver</option>
              <option value="dispatcher">Dispatch</option>
            </select>
          </label>
          <label className="tl-field" style={{ marginTop: 10 }}>What was found
            <textarea name="notes" value={v.notes} onChange={(e) => setV((x) => ({ ...x, notes: e.target.value }))} placeholder="Bolt seal broken, tire slashed" data-autofocus />
          </label>
          <div style={{ ...row, justifyContent: "flex-end", alignItems: "center" }}>
            {error ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{error}</span> : null}
            <button type="button" className="tl-btn" onClick={() => { draft.discard(); setOpen(false); }}>Cancel</button>
            <button type="submit" className="tl-btn danger" disabled={pending || v.notes.trim().length < 3}>
              {pending ? "Saving…" : "Freeze the handoff"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
