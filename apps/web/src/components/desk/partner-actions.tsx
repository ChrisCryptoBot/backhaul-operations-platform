"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { connectPartnerAction, disconnectPartnerAction, factorInvoiceAction, factoringChargebackAction, factoringUpdateAction, importFuelAction, saveFuelCardAction, sendToPayrollAction, syncEldAction, vetCarrierAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { PROVIDERS } from "@/truelane/partners/contract";
import { Modal } from "./kit/modal";
import { ReadOnlyBanner } from "./kit/read-only";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";
import { tried } from "./kit/tried";

/**
 * The seams where a partner company plugs into the desk. Each is a real control that is DISABLED WITH ITS REASON while the company is not connected (no keys on the server, or
 * not connected for this fleet), so a dispatcher sees what will become possible and why it is not yet, rather than a button that fails. Nothing here knows a company's name or
 * call: it asks the server, which does.
 */
const NAMES: Record<string, string> = { triumphpay: "TriumphPay", motive: "Motive", samsara: "Samsara", atob: "AtoB", wex: "WEX" };

/** A button that, when it cannot be used, says why beside it. */
export function ReasonButton({ label, busyLabel, reason, busy, onClick, primary, small }: { label: string; busyLabel?: string; reason: string | null; busy?: boolean; onClick: () => void; primary?: boolean; small?: boolean }) {
  return (
    <span className="rb" title={reason ?? undefined}>
      <button type="button" className={`tl-btn${primary ? " primary" : ""}${small ? " sm" : ""}`} disabled={!!reason || busy} aria-busy={busy || undefined} onClick={onClick} title={reason ?? undefined}>
        {busy ? (busyLabel ?? "Working…") : label}
      </button>
      {reason ? <span className="tl-sub">{reason}</span> : null}
    </span>
  );
}

// ── Factoring ──────────────────────────────────────────────────────────────────────────────────

export type FactorInfo = {
  loadId: string;
  status: string;
  statusLabel: string;
  referenceId: string | null;
  manifest: Array<{ kind: string; label: string; required: boolean; present: boolean }>;
  missingOptional: number;
  blocked: string | null;
  paid?: boolean;
  canAct?: boolean;
  who?: string;
  /** How many loads the invoice carries; more than one says so, because the factor takes them as one invoice. */
  loadCount?: number;
  /** Loads whose only proof of delivery is the driver's phone photo (a link, not a kept file). */
  podPhotoOnly?: number;
  /** What the factor advanced, charged and holds on this invoice, or what the fleet's terms say it should (docs/MONEY_PLAN.md, Wave 2). */
  money?: { advance: number | null; fee: number | null; reserveHeld: number | null; reserveReleased: number | null; chargeback: number | null; expected: { advance: number; reserveHeld: number; fee: number; reserveReleasable: number; netToCarrier: number } | null } | null;
  /** The packet (the invoice, rate confirmations and proofs of delivery as one PDF) and the schedule of accounts, for a batch factor. */
  packetHref?: string;
  scheduleHref?: string;
};

/** The factor charged the invoice back: the advance is owed back and the invoice is the fleet's to collect again. */
function ChargebackButton({ loadId, advance }: { loadId: string; advance: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<{ reason: string }>(`factor-chargeback:${loadId}`, { reason: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function go() {
    setMessage(null);
    if (f.reason.trim().length < 3) return setMessage("Say why the factor charged it back.");
    setBusy(true);
    const got = await tried(() => factoringChargebackAction(loadId, f.reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (got.value.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: `Charged back: ${usd(got.value.amount, 2)} is owed to the factor.`, tone: "bad" });
      router.refresh();
    } else setMessage(got.value.error);
  }
  return (
    <>
      <button type="button" className="tl-btn sm" onClick={() => { setMessage(null); setOpen(true); }}>
        The factor charged it back
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Factoring"
        title="Record a chargeback?"
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void go()}>
              Record the chargeback
            </button>
          </>
        }>
        <form className="dlg-form" onSubmit={(e) => { e.preventDefault(); if (!busy) void go(); }}>
          <p className="tl-note dlg-lead">The customer did not pay, so the factor takes its {usd(advance, 2)} advance back and releases no reserve. The invoice goes back to you to collect, and can be sent to a factor again.</p>
          <label className="tl-field">
            Why
            <input value={f.reason} onChange={(e) => setF({ reason: e.target.value })} maxLength={200} autoComplete="off" />
          </label>
        </form>
      </Modal>
    </>
  );
}

/** The factoring box on an invoice: where it stands with the factor, what the packet holds, and "Send to the factor" (the optional items go missing only by "Send anyway"). */
export function FactorPanel({ info }: { info: FactorInfo }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [anyway, setAnyway] = React.useState(false);
  const [error, setError] = React.useState("");
  const needsAnyway = info.missingOptional > 0;
  const canAct = info.canAct !== false;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const got = await tried(() => factorInvoiceAction(info.loadId, anyway));
      if (!got.ok) {
        setError(got.message);
        return;
      }
      const out = got.value;
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      toast({ text: `Sent to the factor (reference ${out.referenceId}).`, tone: "ok" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const step = async (nextStatus: string, done: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const got = await tried(() => factoringUpdateAction(info.loadId, nextStatus));
      if (!got.ok) {
        setError(got.message);
        return;
      }
      const out = got.value;
      if (!out.ok) {
        setError(out.error ?? "That did not go through.");
        return;
      }
      setError("");
      toast({ text: done, tone: "ok" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tl-card no-print" aria-label="Factoring" style={{ marginBottom: 16 }}>
      <h2>Factoring</h2>
      <p style={{ margin: "0 0 10px" }}>
        <span className={`tl-chip ${info.status === "none" ? "muted" : info.status === "rejected" ? "bad" : info.status === "funded" || info.status === "paid" ? "ok" : "info"}`}>{info.statusLabel}</span>
        {info.referenceId ? <span className="tl-sub" style={{ marginLeft: 8 }}>Reference {info.referenceId}</span> : null}
      </p>
      {info.loadCount && info.loadCount > 1 ? <p className="tl-sub">This invoice carries {info.loadCount} loads. The factor takes it as one invoice, so every load needs its rate confirmation and proof of delivery on file.</p> : null}
      {info.podPhotoOnly ? (
        <p className="tl-note warn">
          {info.podPhotoOnly === 1 ? "One load's" : `${info.podPhotoOnly} loads'`} only proof of delivery is the driver&apos;s phone photo, which is a link and not a kept file. Save it on the load as a proof of delivery to put it in the packet.
        </p>
      ) : null}
      <ul className="tl-sub" style={{ margin: "0 0 10px", paddingLeft: 18 }} aria-label="The packet">
        {info.manifest.map((m) => (
          <li key={m.kind}>
            {m.present ? "✓" : "–"} {m.label}
            {m.required ? " (required)" : m.present ? "" : " (optional, not on file)"}
          </li>
        ))}
      </ul>
      {info.packetHref || info.scheduleHref ? (
        <p className="tl-form-row">
          {info.packetHref ? <a className="tl-btn sm" href={info.packetHref} target="_blank" rel="noopener">Download the packet (PDF)</a> : null}
          {info.scheduleHref ? <a className="tl-btn sm ghost" href={info.scheduleHref}>Schedule of accounts (CSV)</a> : null}
        </p>
      ) : null}
      {info.money && (info.money.advance != null || info.money.chargeback != null || info.money.expected) ? (
        <dl className="tl-kv fp-money" aria-label="What the factor pays">
          {info.money.advance != null ? (
            <>
              <div><dt>Advanced</dt><dd>{usd(info.money.advance, 2)}</dd></div>
              <div><dt>Held in reserve</dt><dd>{usd(info.money.reserveHeld ?? 0, 2)}</dd></div>
              <div><dt>Fee</dt><dd>{usd(info.money.fee ?? 0, 2)}</dd></div>
              {info.money.reserveReleased != null ? <div><dt>Reserve released</dt><dd>{usd(info.money.reserveReleased, 2)}</dd></div> : null}
            </>
          ) : info.money.expected ? (
            <>
              <div><dt>Expected advance</dt><dd>{usd(info.money.expected.advance, 2)}</dd></div>
              <div><dt>Reserve</dt><dd>{usd(info.money.expected.reserveHeld, 2)}</dd></div>
              <div><dt>Fee</dt><dd>{usd(info.money.expected.fee, 2)}</dd></div>
              <div><dt>You end up with</dt><dd>{usd(info.money.expected.netToCarrier, 2)}</dd></div>
            </>
          ) : null}
          {info.money.chargeback != null ? <div><dt>Charged back</dt><dd className="tone-neg">{usd(info.money.chargeback, 2)}</dd></div> : null}
        </dl>
      ) : null}
      {!canAct ? (
        <p className="tl-note" role="note" style={{ margin: 0 }}>
          {info.who ?? "Accounting or Admin"} can send this invoice to the factor or update its status.
        </p>
      ) : info.paid ? null : (
        <>
          <div className="tl-form-row" style={{ alignItems: "flex-start" }}>
            <ReasonButton label="Send to the factor" busyLabel="Sending…" reason={info.blocked} busy={busy} onClick={() => void run()} primary />
            {needsAnyway && !info.blocked ? (
              <label className="dlg-check">
                <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Send anyway, without the items not on file
              </label>
            ) : null}
          </div>
          {info.status === "funded" && info.money?.advance ? (
            <div className="tl-form-row">
              <ChargebackButton loadId={info.loadId} advance={info.money.advance} />
            </div>
          ) : null}
          {NEXT_STEPS[info.status] ? (
            <div className="tl-form-row" style={{ marginTop: 10, alignItems: "center" }}>
              <span className="tl-sub">The factor&apos;s answer, until it is reported automatically:</span>
              {NEXT_STEPS[info.status]!.map((n) => (
                <button key={n.status} type="button" className="tl-btn sm" disabled={busy} aria-busy={busy || undefined} onClick={() => void step(n.status, n.done)}>
                  {n.label}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The steps the desk can record by hand, from each status. Mirrors FACTORING_NEXT on the server, which is what decides. */
const NEXT_STEPS: Record<string, Array<{ status: string; label: string; done: string }> | undefined> = {
  requested: [{ status: "funded", label: "Mark funded", done: "Marked funded." }, { status: "rejected", label: "Mark rejected", done: "Marked rejected." }],
  submitted: [{ status: "funded", label: "Mark funded", done: "Marked funded." }, { status: "rejected", label: "Mark rejected", done: "Marked rejected." }],
  funded: [{ status: "paid", label: "Mark paid by the customer", done: "Marked paid by the customer." }]
};

// ── Hours of service ───────────────────────────────────────────────────────────────────────────

export function SyncEldButton({ reason }: { reason: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  return (
    <ReasonButton
      label="Sync hours from the ELD"
      busyLabel="Syncing…"
      reason={reason}
      busy={pending}
      onClick={() =>
        start(async () => {
          const got = await tried(() => syncEldAction());
          if (!got.ok) {
            toast({ text: got.message, tone: "bad" });
            return;
          }
          const out = got.value;
          toast({ text: out.ok ? `Hours read for ${out.synced} ${out.synced === 1 ? "tractor" : "tractors"}.` : out.error, tone: out.ok ? "ok" : "bad" });
          if (out.ok) router.refresh();
        })
      }
    />
  );
}

// ── Carrier vetting ────────────────────────────────────────────────────────────────────────────

export function VetButton({ driverId, reason }: { driverId: string; reason: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  return (
    <ReasonButton
      small
      label="Check insurance"
      busyLabel="Checking…"
      reason={reason}
      busy={pending}
      onClick={() =>
        start(async () => {
          const got = await tried(() => vetCarrierAction(driverId));
          if (!got.ok) {
            toast({ text: got.message, tone: "bad" });
            return;
          }
          const out = got.value;
          toast({ text: out.ok ? "Carrier checked." : out.error, tone: out.ok ? "ok" : "bad" });
          if (out.ok) router.refresh();
        })
      }
    />
  );
}

// ── Payroll ────────────────────────────────────────────────────────────────────────────────────

/** Checkboxes for the ready statements and one button to send the ticked ones. */
export function PayrollSend({ readyIds, reason, canAct = true, who }: { readyIds: string[]; reason: string | null; canAct?: boolean; who?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [ticked, setTicked] = React.useState<string[]>([]);
  React.useEffect(() => {
    const box = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (!t.matches?.("input[data-payroll]")) return;
      const onPage = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-payroll]"));
      const pageIds = new Set(onPage.map((i) => i.value));
      const checkedOnPage = onPage.filter((i) => i.checked).map((i) => i.value);
      setTicked((prev) => [...prev.filter((id) => !pageIds.has(id)), ...checkedOnPage]);
    };
    document.addEventListener("change", box);
    return () => document.removeEventListener("change", box);
  }, []);
  const pick = (all: boolean) => {
    const chosen = new Set(all ? readyIds : []);
    document.querySelectorAll<HTMLInputElement>("input[data-payroll]").forEach((i) => (i.checked = chosen.has(i.value)));
    setTicked(all ? readyIds : []);
  };

  if (!canAct) return <ReadOnlyBanner who={who ?? "Accounting or Admin"} what="payroll" />;

  async function send() {
    if (busy || ticked.length === 0) return;
    setBusy(true);
    try {
      const got = await tried(() => sendToPayrollAction(ticked));
      if (!got.ok) {
        setError(got.message);
        return;
      }
      const out = got.value;
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      toast({ text: `${out.sent} ${out.sent === 1 ? "statement" : "statements"} sent (reference ${out.reference}).`, tone: "ok" });
      document.querySelectorAll<HTMLInputElement>("input[data-payroll]").forEach((i) => (i.checked = false));
      setTicked([]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tl-form-row" style={{ alignItems: "flex-start" }}>
      <ReasonButton
        label={`Send ${ticked.length > 0 ? ticked.length : ""} to payroll`.replace("  ", " ")}
        busyLabel="Sending…"
        reason={reason ?? (ticked.length === 0 ? "Tick the statements to send." : null)}
        busy={busy}
        primary
        onClick={() => void send()}
      />
      <button type="button" className="tl-btn ghost sm" onClick={() => pick(true)} disabled={busy || readyIds.length === 0}>
        {readyIds.length >= 200 ? "Tick first 200 ready" : "Tick all ready"}
      </button>
      <button type="button" className="tl-btn ghost sm" onClick={() => pick(false)} disabled={busy || ticked.length === 0}>
        Clear
      </button>
      {error ? (
        <p className="tl-note warn" role="alert" style={{ flexBasis: "100%" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ── Fuel cards ─────────────────────────────────────────────────────────────────────────────────

/** Which fuel card and account a truck buys fuel on. */
export function FuelCardForm({ vehicleId, provider, accountId }: { vehicleId: string; provider: string | null; accountId: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  // What is typed is kept until the card is saved.
  const [{ p, a }, setCard, draft] = useDraft(`fuel-card:${vehicleId}`, { p: provider ?? "", a: accountId ?? "" });
  const setP = (v: string) => setCard((c) => ({ ...c, p: v }));
  const setA = (v: string) => setCard((c) => ({ ...c, a: v }));
  const [error, setError] = React.useState("");
  return (
    <form
      className="tl-form-row"
      style={{ alignItems: "flex-end" }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const got = await tried(() => saveFuelCardAction(vehicleId, p, a));
          if (!got.ok) {
            setError(got.message);
            return;
          }
          const out = got.value;
          if (!out.ok) {
            setError(out.error);
            return;
          }
          setError("");
          draft.saved();
          toast({ text: out.changed ? "Fuel card saved." : "Nothing changed.", tone: "ok" });
          router.refresh();
        });
      }}>
      <label className="tl-field" style={{ minWidth: 160 }}>
        Card
        <select value={p} onChange={(e) => setP(e.target.value)}>
          <option value="">No card</option>
          {PROVIDERS.fuel_card.map((x) => (
            <option key={x} value={x}>
              {NAMES[x] ?? x}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field" style={{ minWidth: 200 }}>
        Account on the card
        <input value={a} onChange={(e) => setA(e.target.value)} autoComplete="off" maxLength={60} />
      </label>
      <button type="submit" className="tl-btn sm" disabled={pending} aria-busy={pending || undefined}>
        {pending ? "Saving…" : "Save card"}
      </button>
      {error ? (
        <p className="tl-note warn" role="alert" style={{ flexBasis: "100%" }}>
          {error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * "Import from fuel card" beside a trip's fuel box. It READS the card's purchases for the trip and fills the box only when the box is empty: a number typed by hand is never
 * overwritten (the card's total is shown beside it instead, for the dispatcher to take or not).
 */
export function FuelImport({ loadId, current, onFill }: { loadId: string; current: string; onFill: (amount: string) => void }) {
  const [state, setState] = React.useState<{ busy: boolean; note: string | null; bad: boolean; reason: string | null }>({ busy: false, note: null, bad: false, reason: null });
  const typed = current.trim() !== "";
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
      <button
        type="button"
        className="tl-btn ghost sm"
        disabled={state.busy}
        onClick={async () => {
          setState({ busy: true, note: null, bad: false, reason: null });
          const got = await tried(() => importFuelAction(loadId));
          if (!got.ok) {
            setState({ busy: false, note: got.message, bad: true, reason: null });
            return;
          }
          const out = got.value;
          if (!out.ok) {
            setState({ busy: false, note: out.error, bad: true, reason: null });
            return;
          }
          if (!typed) onFill(String(out.amount));
          setState({ busy: false, bad: false, reason: null, note: typed ? `The card shows ${usd(out.amount, 2)} for ${out.purchases} ${out.purchases === 1 ? "purchase" : "purchases"}. Your number stays.` : `Filled from ${out.purchases} ${out.purchases === 1 ? "purchase" : "purchases"} on the card.` });
        }}>
        {state.busy ? "Reading the card…" : "Import from fuel card"}
      </button>
      {state.note ? <span className={`tl-sub${state.bad ? " neg" : ""}`} role={state.bad ? "alert" : "status"}>{state.note}</span> : null}
    </span>
  );
}
