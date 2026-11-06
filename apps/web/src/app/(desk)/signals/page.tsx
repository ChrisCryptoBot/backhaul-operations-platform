import Link from "next/link";
import React from "react";
import { LEVEL_LABEL, type AlertLevel } from "@/lib/alerts";
import { ageText, type SignalState } from "@/lib/signals";
import { PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { CanGate } from "@/components/desk/kit/can-gate";
import { AcknowledgeSignalButton } from "@/components/desk/acknowledge-signal";
import { Pager } from "@/components/desk/pager";
import { signalCounts, listSignals, syncSignalsIfStale, SIGNAL_PAGE_SIZE, type SignalRow } from "@/server/tl/signals";
import { currentTerminal } from "@/server/tl/terminal";
import { can } from "@/lib/roles";
import { checkAccess } from "@/server/tl/access";

export const metadata = { title: "Signals · TrueLane" };

const STATUSES: SignalState[] = ["open", "acknowledged", "resolved"];
const LEVELS: AlertLevel[] = ["block", "warn", "info"];
const STATUS_LABEL: Record<SignalState, string> = { open: "Open", acknowledged: "Acknowledged", resolved: "Cleared" };

/** How long, in the words the list uses: "New", "Open 3 days", "Cleared after 5 h". */
function lifeOf(s: SignalRow, now: number): string {
  const age = ageText(s.firstSeenAt.getTime(), (s.resolvedAt ?? new Date(now)).getTime());
  const base = s.status === "resolved" ? `Cleared after ${age === "just now" ? "a moment" : age}` : age === "just now" ? "New" : `Open ${age}`;
  const again = s.reopenCount > 0 ? ` · came back ${s.reopenCount === 1 ? "once" : `${s.reopenCount} times`}` : "";
  const by = s.status === "acknowledged" ? ` · acknowledged${s.ackedBy ? ` by ${s.ackedBy}` : ""}` : "";
  return base + again + by;
}

export default async function SignalsPage({ searchParams }: { searchParams?: { status?: string; level?: string; page?: string } }) {
  // The list is kept: syncing here (at most once a minute) means it is never older than that, with or without the scheduled run.
  await syncSignalsIfStale();
  const terminal = await currentTerminal();
  const status = STATUSES.find((s) => s === searchParams?.status) ?? "open";
  const level = LEVELS.find((l) => l === searchParams?.level) ?? null;
  const [counts, list, access] = await Promise.all([signalCounts(terminal), listSignals({ status, level, page: Number(searchParams?.page) || 1 }, terminal), checkAccess("admin")]);
  const now = Date.now();
  const query = (over: { status?: string; level?: string | null; page?: number }) => {
    const p = new URLSearchParams();
    const st = over.status ?? status;
    const lv = over.level === undefined ? level : over.level;
    if (st !== "open") p.set("status", st);
    if (lv) p.set("level", lv);
    if (over.page && over.page > 1) p.set("page", String(over.page));
    const s = p.toString();
    return s ? `/signals?${s}` : "/signals";
  };
  const isAdmin = access.ok && can(access.identity.role, access.identity.grants, "admin");

  return (
    <>
      <PageHead title="Signals" sub="The alerts, kept: when each was first seen, how long it has stayed, who is on it and when it cleared. Worked out from the loads at most once a minute; nothing is changed on a load from here.">
        <Link href="/alerts" className="tl-btn">
          Alerts now
        </Link>
        {isAdmin ? (
          <Link href="/settings?tab=rules" className="tl-btn">
            What is told, and when
          </Link>
        ) : null}
      </PageHead>
      <Tabs active={status} label="Status" hrefFor={(k) => query({ status: k, page: 1 })} items={STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], count: counts[s] }))} />
      <Tabs active={level ?? "all"} label="Level" hrefFor={(k) => query({ level: k === "all" ? null : k, page: 1 })} items={[{ key: "all", label: "Every level" }, ...LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l], ...(status === "open" ? { count: counts.byLevel[l] } : {}) }))]} />
      {list.rows.length === 0 ? (
        <EmptyState icon="check" title={status === "open" ? "Nothing is open" : status === "acknowledged" ? "Nothing is acknowledged" : "Nothing has cleared yet"}>
          {status === "open" ? "Every alert the rules raise is either on someone, or has cleared." : status === "acknowledged" ? "A signal someone is on waits here until it clears or gets worse." : "A signal that stops being raised is kept here with how long it stayed."}
        </EmptyState>
      ) : (
        <div className="al-list" style={{ maxWidth: 920 }}>
          {list.rows.map((s) => (
            <div key={s.id} className="al" data-level={s.level}>
              <span className="lvl">{LEVEL_LABEL[s.level]}</span>
              <div>
                {s.detail}
                <div className="who">
                  {s.loadNumber ?? "Desk"} · {s.title}
                </div>
                <div className="who">{lifeOf(s, now)}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {s.loadId ? (
                  <Link href={`/loads/${s.loadId}`} className="t-btn sm al-act" aria-label={`Open ${s.loadNumber ?? "load"}`}>
                    Open
                  </Link>
                ) : null}
                {s.status === "open" ? (
                  <CanGate caps={["dispatch"]}>
                    <AcknowledgeSignalButton id={s.id} />
                  </CanGate>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
      <Pager page={list.page} pageSize={SIGNAL_PAGE_SIZE} total={list.total} hrefFor={(n) => query({ page: n })} newer="Earlier" older="Later" />
    </>
  );
}
