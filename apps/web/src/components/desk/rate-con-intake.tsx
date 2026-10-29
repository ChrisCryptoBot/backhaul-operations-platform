"use client";

import Link from "next/link";
import React from "react";
import { readSampleRateConAction, saveRateConAction, type DraftDto } from "@/app/(desk)/actions";
import { dateTime, usd } from "@/lib/desk-format";
import { trailerLabel } from "@/truelane/constants/trailerData";

const SAMPLES = [
  { file: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf", label: "Sample 1: Dallas to Houston, one pickup and one delivery" },
  { file: "RC-RDL-77315_fort-worth-waco-austin_box-truck.pdf", label: "Sample 2: Fort Worth, Waco, Austin, a pickup and two deliveries" }
];

const REASONS: Record<string, string> = {
  no_key: "Reading your own file needs an API key. The two sample rate confirmations work without one.",
  unsupported_file: "That file type cannot be read.",
  unreadable: "The reader could not make sense of it.",
  refused: "The reader declined this file.",
  upstream_error: "The reading service did not answer. Try again."
};

/**
 * Rate-confirmation intake: read a file, check the draft, confirm. Nothing becomes a load until the box is ticked.
 * There is no verdict here on purpose: a rate confirmation is for a load that was already accepted.
 */
export function RateConIntake() {
  const [draft, setDraft] = React.useState<DraftDto | null>(null);
  const [source, setSource] = React.useState<"demo" | "live" | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [savedId, setSavedId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function read(file: string) {
    setBusy(true);
    setMessage(null);
    setSavedId(null);
    setConfirmed(false);
    const out = await readSampleRateConAction(file);
    setBusy(false);
    if (out.ok) {
      setDraft(out.draft);
      setSource(out.source);
    } else {
      setDraft(null);
      setMessage(REASONS[out.reason] ?? "Could not read that file.");
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    const out = await saveRateConAction(draft, confirmed);
    setBusy(false);
    if (out.ok) setSavedId(out.loadId);
    else setMessage(out.error);
  }

  const setLoad = (patch: Partial<DraftDto["load"]>) => setDraft((d) => (d ? { ...d, load: { ...d.load, ...patch } } : d));

  return (
    <div>
      <div className="tl-card">
        <h2>Read a rate confirmation</h2>
        <div className="tl-form-row">
          {SAMPLES.map((s) => (
            <button key={s.file} type="button" className="tl-btn" disabled={busy} onClick={() => read(s.file)}>
              {s.label}
            </button>
          ))}
        </div>
        <p className="tl-note" style={{ marginTop: 10 }}>Both samples are fictional documents with invented brokers and shippers.</p>
        {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
      </div>

      {draft ? (
        <div className="tl-card" style={{ marginTop: 14 }}>
          <h2>Check it before it becomes a load {source === "demo" ? "· sample reading" : ""}</h2>
          <div className="tl-form-row" style={{ marginBottom: 12 }}>
            <label className="tl-field">Broker<input value={draft.load.brokerName ?? ""} onChange={(e) => setLoad({ brokerName: e.target.value })} /></label>
            <label className="tl-field">Load number<input value={draft.load.loadNumber ?? ""} onChange={(e) => setLoad({ loadNumber: e.target.value })} /></label>
            <label className="tl-field">PO<input value={draft.load.poNumber ?? ""} onChange={(e) => setLoad({ poNumber: e.target.value })} /></label>
            <label className="tl-field">
              Agreed rate ($)
              <input type="number" step="0.01" value={draft.load.quotedRevenue ?? ""} onChange={(e) => setLoad({ quotedRevenue: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <label className="tl-field">
              Printed miles
              <input type="number" step="1" value={draft.load.loadedMiles ?? ""} onChange={(e) => setLoad({ loadedMiles: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
            <label className="tl-field">
              Pay terms (days)
              <input type="number" step="1" value={draft.load.payTermsDays ?? ""} onChange={(e) => setLoad({ payTermsDays: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          </div>
          <table className="tl-table">
            <thead><tr><th>#</th><th>Stop</th><th>Where</th><th>When</th><th>Numbers</th></tr></thead>
            <tbody>
              {draft.stops.map((s) => (
                <tr key={s.stopSequence}>
                  <td>{s.stopSequence}</td>
                  <td style={{ textTransform: "capitalize" }}>{s.stopType}<div className="tl-sub">{s.facilityName}</div></td>
                  <td>{s.addressString}</td>
                  <td>{dateTime(s.timeWindowEarliest)}</td>
                  <td>{s.referenceNumbers.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="tl-note" style={{ marginTop: 10 }}>
            {draft.load.originAddress} → {draft.load.destinationAddress} · {draft.load.trailerType ? trailerLabel(draft.load.trailerType) : "trailer not set"} · {draft.load.quotedRevenue != null ? usd(draft.load.quotedRevenue, 2) : "no rate read"}
          </p>
          {draft.warnings.map((w) => <p key={w} className="tl-note warn">{w}</p>)}
          <label className="tl-note" style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I checked the details above against the document.
          </label>
          <button type="button" className="tl-btn primary" disabled={busy || !confirmed} onClick={save}>Save as a load</button>
          {savedId ? (
            <p className="tl-note" role="status" style={{ color: "var(--db-pos)", marginTop: 10 }}>
              Saved. <Link href={`/loads/${savedId}`}>Open the load</Link> to assign a driver.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
