import React from "react";
import Link from "next/link";
import { ASSIGNMENT_STATUS, LOAD_STATUS, VERDICT, type Verdict } from "@/lib/desk-format";

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="tl-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {children ? <div className="tl-form-row">{children}</div> : null}
    </div>
  );
}

export function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`tl-card${className ? ` ${className}` : ""}`}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "ok" ? "var(--db-pos)" : tone === "warn" ? "var(--db-warn)" : tone === "bad" ? "var(--db-neg)" : undefined;
  return (
    <div className="tl-card tl-stat">
      <div className="v" style={color ? { color } : undefined}>{value}</div>
      <div className="l">{label}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <span className="tl-chip muted">No cost profile</span>;
  const v = VERDICT[verdict];
  return <span className={`tl-chip ${v.tone}`}>{v.label}</span>;
}

export function StatusChip({ status }: { status: string }) {
  const s = LOAD_STATUS[status] ?? { label: status, tone: "muted" as const };
  return <span className={`tl-chip ${s.tone}`}>{s.label}</span>;
}

export function AssignmentChip({ status }: { status: string | null }) {
  if (!status) return <span className="tl-sub">—</span>;
  const s = ASSIGNMENT_STATUS[status] ?? { label: status, tone: "muted" as const };
  return <span className={`tl-chip ${s.tone}`}>{s.label}</span>;
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
