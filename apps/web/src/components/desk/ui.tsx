import React from "react";
import Link from "next/link";
import { ASSIGNMENT_STATUS, LOAD_STATUS, type Tone, type Verdict } from "@/lib/desk-format";
import { VERDICT_WORD, type VerdictState } from "@/lib/verdict";
import { VerdictTag } from "./verdict-card";

/** The two-letter code each module carries in the rail and on its page head. A page whose title is not here simply has no code. */
const CODES: Record<string, string> = {
  "Quote a load": "QT", Loads: "LD", "Dispatch queue": "DQ", Messages: "MS", Planner: "PL", Alerts: "AL", "Rate confirmations": "RC", Drivers: "DR", Trucks: "TK", Trailers: "TR",
  Customers: "CU", Lanes: "LN", Invoices: "IV", Settlements: "ST", Payroll: "PY", "KPI dashboard": "KP", "Audit log": "AU", Settings: "SE", Fuel: "FU", IFTA: "IF", Schedules: "SC", "Radar map": "MP"
};

export function PageHead({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  const code = CODES[title];
  return (
    <div className="t-pagehead">
      <h1>
        {code ? <i>{code}</i> : null}
        {title}
      </h1>
      {sub ? typeof sub === "string" ? <p>{sub}</p> : <div className="t-dim">{sub}</div> : null}
      {children ? <div className="acts">{children}</div> : null}
    </div>
  );
}

export function Card({ title, action, children, className }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`tl-card${className ? ` ${className}` : ""}`}>
      {title && action ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {action}
        </div>
      ) : title ? (
        <h2>{title}</h2>
      ) : null}
      {children}
    </section>
  );
}

/** A headline figure. Its tone is a square beside it, never a colour on the figure: ink stays white, grey is not known. */
export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="tl-card tl-stat" data-tone={tone}>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

/**
 * The verdict on a board, in the card's own four states. A board row knows accept, caution or reject (and nothing when no truck is on it); it does not carry the market band and gate
 * the card reads (INTEGRATION.md section 3), so until it does the three map straight across and a missing one is "Can't judge yet".
 */
const BOARD_STATE: Record<Verdict, VerdictState> = { accept: "take", caution: "think", reject: "reject", needs_fuel: "unjudged" };
export function VerdictChip({ verdict }: { verdict: Verdict | null }) {
  const state = verdict ? BOARD_STATE[verdict] : "unjudged";
  return <VerdictTag state={state} word={VERDICT_WORD[state]} />;
}

/** Status is a square and a word. Gold ("asks the dispatcher to act") is the amber square; closed and unknown are grey. */
const ST_TONE: Record<Tone, string | undefined> = { ok: "ok", warn: "warn", bad: "bad", info: "info", gold: "warn", muted: undefined };

export function StatusChip({ status }: { status: string }) {
  const s = LOAD_STATUS[status] ?? { label: status, tone: "muted" as const };
  return <span className="t-st" data-tone={ST_TONE[s.tone]}>{s.label}</span>;
}

export function AssignmentChip({ status }: { status: string | null }) {
  if (!status) return <span className="t-dim">—</span>;
  const s = ASSIGNMENT_STATUS[status] ?? { label: status, tone: "muted" as const };
  return <span className="t-st" data-tone={ST_TONE[s.tone]}>{s.label}</span>;
}

export function Tabs({ items, active, hrefFor, label = "Filter" }: { items: Array<{ key: string; label: string; count?: number }>; active: string; hrefFor: (key: string) => string; label?: string }) {
  return (
    <nav className="tl-tabs" aria-label={label}>
      {items.map((t) => (
        <Link key={t.key} href={hrefFor(t.key)} className="tl-tab" aria-current={t.key === active ? "true" : undefined}>
          {t.label}
          {t.count != null ? ` · ${t.count}` : ""}
        </Link>
      ))}
    </nav>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="tl-empty">{children}</div>;
}
