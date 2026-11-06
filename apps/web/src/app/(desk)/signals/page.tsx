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
import { listNotifications } from "@/server/tl/signal-notify";
import { currentAllowed } from "@/server/tl/scope";
import { dateTime } from "@/lib/desk-format";
import { currentTerminal } from "@/server/tl/terminal";
import { can } from "@/lib/roles";
import { checkAccess } from "@/server/tl/access";

export const metadata = { title: "Signals · TrueLane" };

const STATUSES: SignalState[] = ["open", "acknowledged", "resolved"];
const LEVELS: AlertLevel[] = ["block", "warn", "info"];
const STATUS_LABEL: Record<SignalState, string> = { open: "Open", acknowledged: "Acknowledged", resolved: "Cleared" };
const SENT_STATE: Record<string, string> = { sent: "Sent", failed: "Failed", queued: "Sending", skipped: "Skipped" };
const CHANNEL_NAME: Record<string, string> = { sandbox: "Simulator", webhook: "Webhook", resend: "Email", slack: "Slack" };

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
  // What went out, and the weekly report, are whole-desk information: only a person who is not limited to some terminals has them (whatever they have chosen to look at in the header).
  const seesAll = (await currentAllowed()) == null;
  const sentView = seesAll && searchParams?.status === "sent";
  const status = STATUSES.find((s) => s === searchParams?.status) ?? "open";
  const level = LEVELS.find((l) => l === searchParams?.level) ?? null;
  const [counts, list, access, sent] = await Promise.all([signalCounts(terminal), sentView ? Promise.resolve({ rows: [], total: 0, page: 1, pageSize: SIGNAL_PAGE_SIZE }) : listSignals({ status, level, page: Number(searchParams?.page) || 1 }, terminal), checkAccess("admin"), sentView ? listNotifications(50) : Promise.resolve([])]);
  const now = Date.now();
  const query = (over: { status?: string; level?: string | null; page?: number }) => {
    const p = new URLSearchParams();
    const st = over.status ?? (sentView ? "sent" : status);
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
        {seesAll ? (
          <Link href="/signals/report" className="tl-btn">
            Weekly report
          </Link>
        ) : null}
        <Link href="/alerts" className="tl-btn">
          Alerts now
        </Link>
        {isAdmin ? (
          <Link href="/settings?tab=rules" className="tl-btn">
            What is told, and when
          </Link>
        ) : null}
      </PageHead>
      <Tabs active={sentView ? "sent" : status} label="Status" hrefFor={(k) => query({ status: k, page: 1, level: null })} items={[...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], count: counts[s] })), ...(seesAll ? [{ key: "sent", label: "Sent" }] : [])]} />
      {sentView ? null : (
      <Tabs active={level ?? "all"} label="Level" hrefFor={(k) => query({ level: k === "all" ? null : k, page: 1 })} items={[{ key: "all", label: "Every level" }, ...LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l], ...(status === "open" ? { count: counts.byLevel[l] } : {}) }))]} />
      )}
      {sentView ? (
        sent.length === 0 ? (
          <EmptyState icon="inbox" title="Nothing has been sent">When a channel is set up (or the simulator is on), each notification is listed here with what happened to it.</EmptyState>
        ) : (
          <div className="al-list" style={{ maxWidth: 920 }}>
            {sent.map((n) => (
              <div key={n.id} className="al" data-level={n.state === "failed" ? "warn" : "info"}>
                <span className="lvl">{SENT_STATE[n.state] ?? n.state}</span>
                <div>
                  {n.subject ?? "(no subject)"}
                  <div className="who">
                    {CHANNEL_NAME[n.channel] ?? n.channel} · {dateTime(n.at)}{n.attempts > 1 ? ` · ${n.attempts} tries` : ""}{n.error ? ` · ${n.error}` : ""}
                  </div>
                </div>
                <span />
              </div>
            ))}
          </div>
        )
      ) : null}
      {sentView ? null : list.rows.length === 0 ? (
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
      {sentView ? null : <Pager page={list.page} pageSize={SIGNAL_PAGE_SIZE} total={list.total} hrefFor={(n) => query({ page: n })} newer="Earlier" older="Later" />}
    </>
  );
}
