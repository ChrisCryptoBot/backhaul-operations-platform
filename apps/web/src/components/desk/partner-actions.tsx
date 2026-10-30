"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { connectPartnerAction, disconnectPartnerAction, factorInvoiceAction, importFuelAction, saveFuelCardAction, sendToPayrollAction, syncEldAction, vetCarrierAction } from "@/app/(desk)/actions";
import { PROVIDERS } from "@/truelane/partners/contract";
import { useToast } from "./kit/toast";

/**
 * The seams where a partner company plugs into the desk. Each is a real control that is DISABLED WITH ITS REASON while the company is not connected (no keys on the server, or
 * not connected for this fleet), so a dispatcher sees what will become possible and why it is not yet, rather than a button that fails. Nothing here knows a company's name or
 * call: it asks the server, which does.
 */
const NAMES: Record<string, string> = { triumphpay: "TriumphPay", motive: "Motive", samsara: "Samsara", atob: "AtoB", wex: "WEX" };

/** A button that, when it cannot be used, says why beside it. */
export function ReasonButton({ label, busyLabel, reason, busy, onClick, primary, small }: { label: string; busyLabel?: string; reason: string | null; busy?: boolean; onClick: () => void; primary?: boolean; small?: boolean }) {
  return (
    <span className="rb" style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
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
};

/** The factoring box on an invoice: where it stands with the factor, what the packet holds, and "Send to the factor" (the optional items go missing only by "Send anyway"). */
export function FactorPanel({ info }: { info: FactorInfo }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [anyway, setAnyway] = React.useState(false);
  const [error, setError] = React.useState("");
  const needsAnyway = info.missingOptional > 0;
  const run = () =>
    start(async () => {
      const out = await factorInvoiceAction(info.loadId, anyway);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      toast({ text: `Sent to the factor (reference ${out.referenceId}).`, tone: "ok" });
      router.refresh();
    });
  return (
    <section className="tl-card no-print" aria-label="Factoring" style={{ marginBottom: 16 }}>
      <h2>Factoring</h2>
      <p style={{ margin: "0 0 10px" }}>
        <span className={`tl-chip ${info.status === "none" ? "muted" : info.status === "rejected" ? "bad" : info.status === "funded" || info.status === "paid" ? "ok" : "info"}`}>{info.statusLabel}</span>
        {info.referenceId ? <span className="tl-sub" style={{ marginLeft: 8 }}>Reference {info.referenceId}</span> : null}
      </p>
      <ul className="tl-sub" style={{ margin: "0 0 10px", paddingLeft: 18 }} aria-label="The packet">
        {info.manifest.map((m) => (
          <li key={m.kind}>
            {m.present ? "✓" : "–"} {m.label}
            {m.required ? " (required)" : m.present ? "" : " (optional, not on file)"}
          </li>
        ))}
      </ul>
      <div className="tl-form-row" style={{ alignItems: "flex-start" }}>
        <ReasonButton label="Send to the factor" busyLabel="Sending…" reason={info.blocked} busy={pending} onClick={run} primary />
        {needsAnyway && !info.blocked ? (
          <label className="dlg-check">
            <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} /> Send anyway, without the items not on file
          </label>
        ) : null}
      </div>
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

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
          const out = await syncEldAction();
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
          const out = await vetCarrierAction(driverId);
          toast({ text: out.ok ? "Carrier checked." : out.error, tone: out.ok ? "ok" : "bad" });
          if (out.ok) router.refresh();
        })
      }
    />
  );
}

// ── Payroll ────────────────────────────────────────────────────────────────────────────────────

/** Checkboxes for the ready statements and one button to send the ticked ones. */
export function PayrollSend({ readyIds, reason }: { readyIds: string[]; reason: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState("");
  const [ticked, setTicked] = React.useState<string[]>([]);
  React.useEffect(() => {
    const box = (e: Event) => {
      const t = e.target as HTMLInputElement;
      if (!t.matches?.("input[data-payroll]")) return;
      setTicked(Array.from(document.querySelectorAll<HTMLInputElement>("input[data-payroll]:checked")).map((i) => i.value));
    };
    document.addEventListener("change", box);
    return () => document.removeEventListener("change", box);
  }, []);
  const pick = (all: boolean) => {
    document.querySelectorAll<HTMLInputElement>("input[data-payroll]").forEach((i) => (i.checked = all));
    setTicked(all ? readyIds : []);
  };
  return (
    <div className="tl-form-row" style={{ alignItems: "flex-start" }}>
      <ReasonButton
        label={`Send ${ticked.length > 0 ? ticked.length : ""} to payroll`.replace("  ", " ")}
        busyLabel="Sending…"
        reason={reason ?? (ticked.length === 0 ? "Tick the statements to send." : null)}
        busy={pending}
        primary
        onClick={() =>
          start(async () => {
            const out = await sendToPayrollAction(ticked);
            if (!out.ok) {
              setError(out.error);
              return;
            }
            setError("");
            toast({ text: `${out.sent} ${out.sent === 1 ? "statement" : "statements"} sent (reference ${out.reference}).`, tone: "ok" });
            setTicked([]);
            router.refresh();
          })
        }
      />
      <button type="button" className="tl-btn ghost sm" onClick={() => pick(true)} disabled={readyIds.length === 0}>
        Tick all ready
      </button>
      <button type="button" className="tl-btn ghost sm" onClick={() => pick(false)} disabled={ticked.length === 0}>
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
  const [p, setP] = React.useState(provider ?? "");
  const [a, setA] = React.useState(accountId ?? "");
  const [error, setError] = React.useState("");
  return (
    <form
      className="tl-form-row"
      style={{ alignItems: "flex-end" }}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const out = await saveFuelCardAction(vehicleId, p, a);
          if (!out.ok) {
            setError(out.error);
            return;
          }
          setError("");
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
          const out = await importFuelAction(loadId);
          if (!out.ok) {
            setState({ busy: false, note: out.error, bad: true, reason: null });
            return;
          }
          if (!typed) onFill(String(out.amount));
          setState({ busy: false, bad: false, reason: null, note: typed ? `The card shows $${out.amount.toFixed(2)} for ${out.purchases} ${out.purchases === 1 ? "purchase" : "purchases"}. Your number stays.` : `Filled from ${out.purchases} ${out.purchases === 1 ? "purchase" : "purchases"} on the card.` });
        }}>
        {state.busy ? "Reading the card…" : "Import from fuel card"}
      </button>
      {state.note ? <span className={`tl-sub${state.bad ? " neg" : ""}`} role={state.bad ? "alert" : "status"}>{state.note}</span> : null}
    </span>
  );
}

// ── Settings: which companies are connected ────────────────────────────────────────────────────

export type IntegrationRow = { capability: string; label: string; provider: string; name: string; configured: boolean; connected: boolean; accountLabel: string | null };

export function IntegrationsList({ rows }: { rows: IntegrationRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState("");
  const act = (r: IntegrationRow, connect: boolean) =>
    start(async () => {
      const out = connect ? await connectPartnerAction(r.capability, r.provider, null) : await disconnectPartnerAction(r.capability, r.provider);
      if (!out.ok) {
        setError(out.error);
        return;
      }
      setError("");
      toast({ text: connect ? `${r.name} connected.` : `${r.name} disconnected.`, tone: "ok" });
      router.refresh();
    });
  return (
    <>
      <table className="tl-table" aria-label="Partner companies">
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Company</th>
            <th scope="col">State</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.capability}:${r.provider}`}>
              <td>{r.label}</td>
              <td>{r.name}</td>
              <td>{r.connected ? <span className="tl-chip ok">Connected</span> : r.configured ? <span className="tl-chip info">Ready to connect</span> : <span className="tl-chip muted">Keys not set on the server</span>}</td>
              <td style={{ textAlign: "right" }}>
                {r.connected ? (
                  <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => act(r, false)}>
                    Disconnect
                  </button>
                ) : (
                  <button type="button" className="tl-btn sm" disabled={pending || !r.configured} title={r.configured ? undefined : `${r.name} has no keys on the server yet.`} onClick={() => act(r, true)}>
                    Connect
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </>
  );
}
