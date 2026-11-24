import React from "react";
import Link from "next/link";
import { ASSIGNMENT_STATUS, LOAD_STATUS, type Tone, type Verdict } from "@/lib/desk-format";
import { VERDICT_WORD, type VerdictState } from "@/lib/verdict";
import { VerdictTag } from "./verdict-card";
import { ScopeChip } from "./scope-menu";
import { MODULE_CODE } from "@/lib/nav";

/**
 * The head of a module: its title and its actions, which stay on screen as the page scrolls (terminal.css pins `.t-pagehead`, and each module's tab or filter bar under it). The one-line description
 * is not part of that bar, so what stays pinned is slim; it scrolls away with the page.
 */
export function PageHead({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  const code = MODULE_CODE[title];
  return (
    <>
      <div className="t-pagehead">
        <h1>
          {code ? <i>{code}</i> : null}
          {title}
        </h1>
        <ScopeChip />
        {children ? <div className="acts">{children}</div> : null}
      </div>
      {sub ? <div className="t-pagesub">{typeof sub === "string" ? <p>{sub}</p> : sub}</div> : null}
    </>
  );
}

export function Card({ title, action, children, className }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`tl-card${className ? ` ${className}` : ""}`}>
      {title && action ? (
        <div className="t-head">
          <h2>{title}</h2>
          <div className="acts">{action}</div>
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

/**
 * Links that narrow the list (underlined words), or, with `view`, that swap which list this is (a segmented switch). Two kinds that look different, so two chosen words never sit side by side looking alike.
 */
export function Tabs({ items, active, hrefFor, label = "Filter", view = false }: { items: Array<{ key: string; label: string; count?: number }>; active: string; hrefFor: (key: string) => string; label?: string; view?: boolean }) {
  if (view)
    return (
      <nav className="t-seg t-views" aria-label={label}>
        {items.map((t) => (
          <Link key={t.key} href={hrefFor(t.key)} className="t-view" aria-current={t.key === active ? "true" : undefined}>
            {t.label}
            {t.count != null ? <em>{t.count}</em> : null}
          </Link>
        ))}
      </nav>
    );
  return (
    <nav className="tl-tabs" aria-label={label}>
      {items.map((t) => (
        <Link key={t.key} href={hrefFor(t.key)} className="tl-tab" aria-current={t.key === active ? "true" : undefined}>
          {t.label}
          {t.count != null ? <em>{t.count}</em> : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * A row that opens something: the link's own target covers the whole row (terminal.css `.row-link`), so there is one tab stop and no Open button repeated down the list. Put it in an element with
 * `.row-open`; buttons in the row sit above it and keep their own clicks.
 */
export function RowLink({ href, children, label }: { href: string; children: React.ReactNode; label?: string }) {
  return (
    <Link href={href} className="row-link" aria-label={label}>
      {children}
    </Link>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="tl-empty">{children}</div>;
}
