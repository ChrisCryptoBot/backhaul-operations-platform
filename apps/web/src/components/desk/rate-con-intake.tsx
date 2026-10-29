"use client";

import Link from "next/link";
import React from "react";
import { readSampleRateConAction, readUploadedRateConAction, saveRateConAction, type DraftDto, type ReadResult } from "@/app/(desk)/actions";
import { dateTime, perMile, usd } from "@/lib/desk-format";
import { needsStopCheck, rateConChecks } from "@/lib/rate-con-checks";
import { parseCentralLocal, toCentralLocal } from "@/lib/zoned";
import { cityState } from "@/server/ratecon/map";
import { trailerLabel } from "@/truelane/constants/trailerData";
import { AddressInput } from "./address-input";
import { Icon } from "./kit/icons";

const SAMPLES = [
  { file: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf", title: "Sample 1", lane: "Dallas, TX to Houston, TX", detail: "One pickup, one delivery · cargo van" },
  { file: "RC-RDL-77315_fort-worth-waco-austin_box-truck.pdf", title: "Sample 2", lane: "Fort Worth, Waco and Austin, TX", detail: "One pickup, two deliveries · box truck" }
];

const REASONS: Record<string, string> = {
  no_key: "That file can only be read with a reading key, and none is set on this machine. The two samples read without one.",
  unsupported_file: "That file type cannot be read. Use a PDF, or a photo or screenshot (PNG, JPG, WebP).",
  too_big: "That file is over 10 MB. Use a smaller scan or a screenshot.",
  unreadable: "The reader could not make sense of that document.",
  refused: "The reader declined this file.",
  upstream_error: "The reading service did not answer. Try again."
};

const STEPS = ["Read a document", "Check what was read", "Save as a draft load"];

type Stage = "pick" | "reading" | "check" | "saved";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

/**
 * Rate-confirmation intake: read a document, check and correct what was read, then save it as a draft load.
 * Nothing becomes a load until the box is ticked. There is no verdict here on purpose: a rate confirmation is for a
 * load that was already accepted, so the page shows what the document says and the arithmetic on it, not a judgement.
 */
export function RateConIntake({ liveReading, trucks }: { liveReading: boolean; trucks: Array<{ id: string; name: string | null }> }) {
  const [stage, setStage] = React.useState<Stage>("pick");
  const [draft, setDraft] = React.useState<DraftDto | null>(null);
  const [source, setSource] = React.useState<"demo" | "live">("demo");
  const [fileName, setFileName] = React.useState("");
  const [duplicateOf, setDuplicateOf] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  // The stops box is ticked for one set of confirm-level checks; if the stops change so that the checks change, it clears itself.
  const [stopsTicked, setStopsTicked] = React.useState<string | null>(null);
  const [savedId, setSavedId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [over, setOver] = React.useState(false);
  // Kept between documents: a dispatcher reading a stack of them for one truck should not have to pick it every time.
  const [vehicleId, setVehicleId] = React.useState(trucks.length === 1 ? trucks[0]!.id : "");

  function arrive(out: ReadResult) {
    if (out.ok) {
      setDraft(out.draft);
      setSource(out.source);
      setFileName(out.fileName);
      setStage("check");
    } else {
      setDraft(null);
      setMessage(REASONS[out.reason] ?? "Could not read that file.");
      setStage("pick");
    }
  }

  async function begin(name: string, run: () => Promise<ReadResult>) {
    setStage("reading");
    setFileName(name);
    setMessage(null);
    setSavedId(null);
    setConfirmed(false);
    setStopsTicked(null);
    try {
      arrive(await run());
    } catch {
      arrive({ ok: false, reason: "upstream_error" });
    }
  }

  const readSample = (file: string) => begin(file, () => readSampleRateConAction(file));
  const readFile = (file: File) => {
    const form = new FormData();
    form.set("file", file);
    return begin(file.name, () => readUploadedRateConAction(form));
  };

  function reset() {
    setStage("pick");
    setDraft(null);
    setMessage(null);
    setConfirmed(false);
    setStopsTicked(null);
    setSavedId(null);
  }

  const setLoad = (patch: Partial<DraftDto["load"]>) => setDraft((d) => (d ? { ...d, load: { ...d.load, ...patch } } : d));
  const setStop = (i: number, patch: Partial<DraftDto["stops"][number]>) =>
    setDraft((d) => (d ? { ...d, stops: d.stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) } : d));

  /** Moving the appointment moves the end of the window with it, so a two-hour window stays two hours. */
  function moveStop(i: number, local: string) {
    const start = parseCentralLocal(local);
    setDraft((d) => {
      if (!d) return d;
      const stop = d.stops[i]!;
      if (start == null) return { ...d, stops: d.stops.map((s, k) => (k === i ? { ...s, timeWindowEarliest: null, timeWindowLatest: null } : s)) };
      const before = stop.timeWindowEarliest ? new Date(stop.timeWindowEarliest).getTime() : null;
      const after = stop.timeWindowLatest && before != null ? start + (new Date(stop.timeWindowLatest).getTime() - before) : start;
      return { ...d, stops: d.stops.map((s, k) => (k === i ? { ...s, timeWindowEarliest: new Date(start).toISOString(), timeWindowLatest: new Date(after).toISOString() } : s)) };
    });
  }

  const problems: string[] = [];
  if (draft) {
    if (draft.load.quotedRevenue == null || draft.load.quotedRevenue <= 0) problems.push("Type the agreed rate.");
    if (draft.stops.length === 0) problems.push("A load needs at least one stop.");
    if (draft.stops.some((s) => s.addressString.trim() === "")) problems.push("Every stop needs an address.");
  }

  const checks = draft ? rateConChecks({ stops: draft.stops, loadedMiles: draft.load.loadedMiles }) : [];
  const stopsSignature = checks.filter((c) => c.level === "confirm").map((c) => c.id).join(",");
  const stopsOk = !needsStopCheck(checks) || stopsTicked === stopsSignature;

  async function save(allowDuplicate = false) {
    if (!draft || problems.length > 0 || !stopsOk) return;
    setSaving(true);
    setMessage(null);
    setDuplicateOf(null);
    // The lane follows the stops, so a corrected address changes the load's from and to as well.
    const first = draft.stops[0];
    const last = draft.stops[draft.stops.length - 1];
    const out = await saveRateConAction(
      { ...draft, load: { ...draft.load, originAddress: cityState(first?.addressString ?? null) ?? draft.load.originAddress, destinationAddress: cityState(last?.addressString ?? null) ?? draft.load.destinationAddress, stopsCount: draft.stops.length } },
      confirmed,
      vehicleId || null,
      fileName || null,
      allowDuplicate
    );
    setSaving(false);
    if (out.ok) {
      setSavedId(out.loadId);
      setStage("saved");
    } else {
      setMessage(out.error);
      setDuplicateOf(out.duplicateOf ?? null);
    }
  }

  const step = stage === "saved" ? 2 : stage === "check" ? 1 : 0;

  return (
    <div className="rc">
      <ol className="rc-steps" aria-label="Where you are">
        {STEPS.map((label, i) => (
          <li key={label} className={i < step || stage === "saved" ? "done" : ""} aria-current={i === step && stage !== "saved" ? "step" : undefined}>
            <span className="n">{i < step || stage === "saved" ? <Icon name="check" size={12} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {stage === "pick" || stage === "reading" ? (
        <div className="tl-card rc-intake" aria-busy={stage === "reading" || undefined}>
          <label
            className={`rc-drop${over ? " over" : ""}${stage === "reading" ? " busy" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const file = e.dataTransfer.files[0];
              if (file && stage === "pick") void readFile(file);
            }}>
            <input
              className="rc-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              disabled={stage === "reading"}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void readFile(file);
              }}
            />
            <span className="ico">
              <Icon name="document" size={22} />
            </span>
            {stage === "reading" ? (
              <>
                <strong>Reading {fileName}…</strong>
                <span className="sub" role="status">Pulling out the stops, times, numbers and rate.</span>
              </>
            ) : (
              <>
                <strong>Drop a rate confirmation here</strong>
                <span className="sub">or choose a file · PDF, photo or screenshot, up to 10 MB</span>
              </>
            )}
          </label>

          <div className="rc-samples">
            <h2 className="rc-eyebrow">Or try a sample</h2>
            {SAMPLES.map((s) => (
              <button key={s.file} type="button" className="rc-sample" disabled={stage === "reading"} onClick={() => void readSample(s.file)}>
                <b>{s.title}</b>
                <span>{s.lane}</span>
                <span className="dim">{s.detail}</span>
              </button>
            ))}
            <p className="tl-note">
              {liveReading
                ? "Your own documents are sent to the reading service. Nothing is saved until you confirm it."
                : "Reading your own documents needs a reading key, and none is set on this machine. The samples are invented documents and read without one."}
            </p>
          </div>
        </div>
      ) : null}

      {message && !duplicateOf ? (
        <p className="tl-note warn rc-msg" role="alert">
          {message}
        </p>
      ) : null}

      {stage === "check" && draft ? (
        <>
          <div className="rc-bar">
            <span className="ico">
              <Icon name="document" size={18} />
            </span>
            <span className="grow">
              <b>{fileName}</b>
            </span>
            <span className={`tl-chip ${source === "demo" ? "muted" : "info"}`}>{source === "demo" ? "Sample reading" : "Read just now"}</span>
            <button type="button" className="tl-btn sm" onClick={reset}>
              Read another
            </button>
          </div>

          <div className="rc-review">
            <div className="rc-main">
              <section className="tl-card">
                <h2>The load</h2>
                <div className="rc-grid">
                  <label className="tl-field">
                    Broker
                    <input value={draft.load.brokerName ?? ""} onChange={(e) => setLoad({ brokerName: e.target.value })} autoComplete="off" />
                  </label>
                  <label className="tl-field">
                    Load number
                    <input value={draft.load.loadNumber ?? ""} onChange={(e) => setLoad({ loadNumber: e.target.value })} autoComplete="off" />
                  </label>
                  <label className="tl-field">
                    PO number
                    <input value={draft.load.poNumber ?? ""} onChange={(e) => setLoad({ poNumber: e.target.value })} autoComplete="off" />
                  </label>
                  <label className="tl-field">
                    Runs on
                    <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                      <option value="">No truck yet</option>
                      {trucks.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <span className="rc-hint">Sets the cost floor for this load.</span>
                  </label>
                  <label className="tl-field">
                    Agreed rate ($)
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      value={draft.load.quotedRevenue ?? ""}
                      aria-invalid={problems.includes("Type the agreed rate.") || undefined}
                      onChange={(e) => setLoad({ quotedRevenue: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                    {draft.printed.fuelSurchargeIncluded ? <span className="rc-hint">{`Includes ${usd(draft.printed.fuelSurchargeIncluded, 2)} fuel surcharge.`}</span> : null}
                  </label>
                  <label className="tl-field">
                    Printed miles
                    <input type="number" min="0" step="0.1" inputMode="decimal" value={draft.load.loadedMiles ?? ""} onChange={(e) => setLoad({ loadedMiles: e.target.value === "" ? null : Number(e.target.value) })} />
                    {draft.load.quotedRevenue != null && draft.load.quotedRevenue > 0 && draft.load.loadedMiles ? <span className="rc-hint">{`The rate comes to ${perMile(draft.load.quotedRevenue / draft.load.loadedMiles)} on these miles.`}</span> : null}
                  </label>
                  <label className="tl-field">
                    Pay terms (days)
                    <input type="number" min="0" step="1" inputMode="numeric" value={draft.load.payTermsDays ?? ""} onChange={(e) => setLoad({ payTermsDays: e.target.value === "" ? null : Number(e.target.value) })} />
                    {draft.load.paymentTerms ? <span className="rc-hint">{`Printed as “${draft.load.paymentTerms}”.`}</span> : null}
                  </label>
                </div>
              </section>

              <section className="tl-card">
                <h2>{`Stops · ${draft.stops.length}`}</h2>
                {draft.stops.length === 0 ? (
                  <p className="tl-note warn">No stops were read from this document.</p>
                ) : (
                  <ol className="rc-stops">
                    {draft.stops.map((s, i) => {
                      const ends = s.timeWindowEarliest && s.timeWindowLatest && s.timeWindowLatest !== s.timeWindowEarliest ? s.timeWindowLatest : null;
                      return (
                        <li key={s.stopSequence} className={`rc-stop ${s.stopType}`}>
                          <span className="badge" aria-hidden="true">
                            {i + 1}
                          </span>
                          <div className="rc-stop-body">
                            <div className="rc-stop-head">
                              <span className="qt-role">{s.stopType === "pickup" ? "Pickup" : "Delivery"}</span>
                              {ends ? <span className="tl-sub">Window ends {clock(ends)} CT</span> : null}
                              {s.contactPhone ? <span className="tl-sub">{s.contactPhone}</span> : null}
                            </div>
                            <div className="rc-stop-grid">
                              <label className="tl-field">
                                <span>Facility<span className="db-sr-only"> for stop {i + 1}</span></span>
                                <input value={s.facilityName ?? ""} onChange={(e) => setStop(i, { facilityName: e.target.value })} autoComplete="off" />
                              </label>
                              <label className="tl-field">
                                <span>Address<span className="db-sr-only"> for stop {i + 1}</span></span>
                                <AddressInput label={`Address for stop ${i + 1}`} value={s.addressString} onChange={(text) => setStop(i, { addressString: text })} invalid={s.addressString.trim() === ""} />
                              </label>
                              <label className="tl-field">
                                <span>Appointment, Dallas time<span className="db-sr-only"> for stop {i + 1}</span></span>
                                <input type="datetime-local" value={s.timeWindowEarliest ? toCentralLocal(new Date(s.timeWindowEarliest).getTime()) : ""} onChange={(e) => moveStop(i, e.target.value)} />
                              </label>
                            </div>
                            {s.referenceNumbers.length > 0 || s.stopNotes ? (
                              <div className="rc-refs">
                                {s.referenceNumbers.map((r) => (
                                  <span key={r} className="tl-chip muted">
                                    {r}
                                  </span>
                                ))}
                                {s.stopNotes ? <span className="tl-sub">{s.stopNotes}</span> : null}
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              {draft.printed.commodity || draft.printed.weightLbs || draft.printed.dockTerms || draft.printed.notes || draft.printed.tonuOnly ? (
                <section className="tl-card">
                  <h2>Also printed</h2>
                  <dl className="rc-printed">
                    {draft.printed.tonuOnly ? (
                      <>
                        <dt>Pays</dt>
                        <dd>A TONU fee only: nothing was hauled.</dd>
                      </>
                    ) : null}
                    {draft.printed.commodity ? (
                      <>
                        <dt>Commodity</dt>
                        <dd>{draft.printed.commodity}</dd>
                      </>
                    ) : null}
                    {draft.printed.weightLbs ? (
                      <>
                        <dt>Weight</dt>
                        <dd>{draft.printed.weightLbs.toLocaleString("en-US")} lb</dd>
                      </>
                    ) : null}
                    {draft.printed.dockTerms ? (
                      <>
                        <dt>Dock terms</dt>
                        <dd>{draft.printed.dockTerms}</dd>
                      </>
                    ) : null}
                    {draft.printed.notes ? (
                      <>
                        <dt>Notes</dt>
                        <dd>{draft.printed.notes}</dd>
                      </>
                    ) : null}
                  </dl>
                </section>
              ) : null}
            </div>

            <aside className="rc-side" aria-label="What will be saved">
              <h2 className="rc-eyebrow">Will be saved as</h2>
              <div className="qt-big">{draft.load.quotedRevenue != null && draft.load.quotedRevenue > 0 ? usd(draft.load.quotedRevenue, 2) : "—"} <span>agreed rate</span></div>
              <p className="rc-lane">
                {cityState(draft.stops[0]?.addressString ?? null) ?? draft.load.originAddress ?? "—"} to {cityState(draft.stops[draft.stops.length - 1]?.addressString ?? null) ?? draft.load.destinationAddress ?? "—"}
              </p>
              <dl className="rc-facts">
                <div>
                  <dt>Broker</dt>
                  <dd>{draft.load.brokerName || "—"}</dd>
                </div>
                <div>
                  <dt>Truck</dt>
                  <dd>{trucks.find((t) => t.id === vehicleId)?.name ?? "None yet"}</dd>
                </div>
                <div>
                  <dt>Stops</dt>
                  <dd>{draft.stops.length}</dd>
                </div>
                <div>
                  <dt>Equipment</dt>
                  <dd>{draft.load.trailerType ? trailerLabel(draft.load.trailerType) : "Not set"}</dd>
                </div>
                <div>
                  <dt>First stop</dt>
                  <dd>{dateTime(draft.stops[0]?.timeWindowEarliest)}</dd>
                </div>
              </dl>

              {draft.warnings.length > 0 ? (
                <div className="rc-warns">
                  <p className="rc-eyebrow">The reader was unsure of</p>
                  <ul>
                    {draft.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {checks.length > 0 ? (
                <div className="rc-warns">
                  <p className="rc-eyebrow">Worth a second look</p>
                  <ul>
                    {checks.map((c) => (
                      <li key={c.id}>{c.text}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {problems.length > 0 ? (
                <ul className="rc-todo" role="status">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}

              {needsStopCheck(checks) ? (
                <label className="dlg-check rc-confirm">
                  <input type="checkbox" checked={stopsTicked === stopsSignature} onChange={(e) => setStopsTicked(e.target.checked ? stopsSignature : null)} />
                  I checked the stops and their order.
                </label>
              ) : null}
              <label className="dlg-check rc-confirm">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I checked these details against the document.
              </label>
              <button type="button" className="tl-btn primary" disabled={saving || !confirmed || problems.length > 0 || !stopsOk} aria-busy={saving || undefined} onClick={() => void save()}>
                {saving ? "Saving…" : "Save as a draft load"}
              </button>
              {duplicateOf ? (
                <p className="tl-note warn" role="alert">
                  {message} <Link href={`/loads/${duplicateOf}`} target="_blank">Open the existing load</Link>
                  <button type="button" className="tl-btn sm" style={{ marginLeft: 8 }} disabled={saving} onClick={() => void save(true)}>
                    Save anyway
                  </button>
                </p>
              ) : null}
              <p className="tl-note">It lands on the Dispatch queue, needing a driver. No verdict: the load is already agreed.</p>
            </aside>
          </div>
        </>
      ) : null}

      {stage === "saved" && draft ? (
        <div className="tl-card rc-done" role="status">
          <span className="ico ok">
            <Icon name="check" size={22} />
          </span>
          <div className="grow">
            <h3>{draft.load.loadNumber ? `${draft.load.loadNumber} saved as a draft load` : "Saved as a draft load"}</h3>
            <p className="tl-note">
              {cityState(draft.stops[0]?.addressString ?? null) ?? "—"} to {cityState(draft.stops[draft.stops.length - 1]?.addressString ?? null) ?? "—"} · {draft.load.quotedRevenue != null ? usd(draft.load.quotedRevenue, 2) : "no rate"} · it is on the Dispatch queue, needing a driver.
            </p>
          </div>
          {savedId ? (
            <Link className="tl-btn primary" href={`/loads/${savedId}`}>
              Open the load
            </Link>
          ) : null}
          <button type="button" className="tl-btn" onClick={reset}>
            Read another
          </button>
        </div>
      ) : null}
    </div>
  );
}
