import Link from "next/link";
import React from "react";
import { LEVEL_LABEL, type AlertLevel } from "@/lib/alerts";
import { ageText, type SignalState } from "@/lib/signals";
import { PageHead, Tabs } from "@/components/desk/ui";
import { DataTable, type Column } from "@/components/desk/data-table";
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

const TONE: Record<AlertLevel, string> = { block: "bad", warn: "warn", info: "info" };

/** How long it has stayed (or stayed, for one that cleared): "New", "12 days", "a moment". */
function stayed(s: SignalRow, now: number): string {
  const age = ageText(s.firstSeenAt.getTime(), (s.resolvedAt ?? new Date(now)).getTime());
  return age === "just now" ? (s.status === "resolved" ? "a moment" : "New") : age;
}

/** The record: one line a signal. Level, which load, what, since when, for how long, who is on it. */
const columnsFor = (status: SignalState): Column[] => [
  { key: "level", label: "Level", sticky: true, width: 88 },
  { key: "load", label: "Load", width: 110 },
  { key: "what", label: "What", max: 380 },
  { key: "first", label: "First seen", priority: 2 },
  { key: "age", label: status === "resolved" ? "Stayed" : "Open for", align: "num" },
  { key: "back", label: "Came back", align: "num", priority: 3 },
  { key: "owner", label: "Who is on it", max: 150, priority: 2 },
  ...(status === "resolved" ? [{ key: "cleared", label: "Cleared", priority: 2 as const }] : []),
  ...(status === "open" ? [{ key: "act", label: "" }] : [])
];
const SENT_COLUMNS: Column[] = [
  { key: "state", label: "State", sticky: true, width: 100 },
  { key: "subject", label: "What was said", max: 400 },
  { key: "channel", label: "Channel" },
  { key: "when", label: "When" },
  { key: "tries", label: "Tries", align: "num", priority: 2 },
  { key: "error", label: "Problem", max: 240, priority: 2 }
];

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
      <PageHead title="Signals" sub="The record of the alerts: when each was first seen, how long it has stayed, who is on it and when it cleared. What to do now is on Alerts.">
        <Link href="/alerts" className="tl-btn ghost">
          Alerts now
        </Link>
        {isAdmin ? (
          <Link href="/settings?tab=rules" className="tl-btn ghost">
            What is told, and when
          </Link>
        ) : null}
        {seesAll ? (
          <Link href="/signals/report" className="tl-btn">
            Weekly report
          </Link>
        ) : null}
      </PageHead>
      <div className="dt-toolbar">
        <Tabs view active={sentView ? "sent" : status} label="Status" hrefFor={(k) => query({ status: k, page: 1, level: null })} items={[...STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s], count: counts[s] })), ...(seesAll ? [{ key: "sent", label: "Sent" }] : [])]} />
        {sentView ? null : <Tabs active={level ?? "all"} label="Level" hrefFor={(k) => query({ level: k === "all" ? null : k, page: 1 })} items={[{ key: "all", label: "Every level" }, ...LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l], ...(status === "open" ? { count: counts.byLevel[l] } : {}) }))]} />}
        <span className="dt-spacer" />
        <span className="dt-count">{sentView ? `${sent.length} sent` : `${list.total} ${list.total === 1 ? "signal" : "signals"}`}</span>
      </div>
      {sentView ? (
        <DataTable
          id="signals-sent"
          label="What was sent"
          columns={SENT_COLUMNS}
          empty={<EmptyState icon="inbox" title="Nothing has been sent">When a channel is set up (or the simulator is on), each notification is listed here with what happened to it.</EmptyState>}
          rows={sent.map((n) => ({
            id: n.id,
            cells: {
              state: <span className="t-st say" data-tone={n.state === "failed" ? "bad" : n.state === "sent" ? "ok" : undefined}>{SENT_STATE[n.state] ?? n.state}</span>,
              subject: <span className="cut" title={n.subject ?? undefined}>{n.subject ?? "(no subject)"}</span>,
              channel: CHANNEL_NAME[n.channel] ?? n.channel,
              when: dateTime(n.at),
              tries: n.attempts,
              error: n.error ? <span className="cut" title={n.error}>{n.error}</span> : <span className="dim">—</span>
            }
          }))}
        />
      ) : (
        <DataTable
          id="signals-table"
          label={`${STATUS_LABEL[status]} signals`}
          columns={columnsFor(status)}
          empty={
            <EmptyState icon={status === "open" ? "check" : "inbox"} title={status === "open" ? "Nothing is open" : status === "acknowledged" ? "Nothing is acknowledged" : "Nothing has cleared yet"}>
              {status === "open" ? "Every alert the rules raise is either on someone, or has cleared." : status === "acknowledged" ? "A signal someone is on waits here until it clears or gets worse." : "A signal that stops being raised is kept here with how long it stayed."}
            </EmptyState>
          }
          rows={list.rows.map((s) => ({
            id: s.id,
            href: s.loadId ? `/loads/${s.loadId}` : undefined,
            cells: {
              level: <span className="t-st" data-tone={TONE[s.level]}>{LEVEL_LABEL[s.level]}</span>,
              load: s.loadId ? <Link href={`/loads/${s.loadId}`}>{s.loadNumber ?? "Load"}</Link> : "Desk",
              what: (
                <span className="cut" title={`${s.title}. ${s.detail}`}>
                  {s.detail}
                </span>
              ),
              first: dateTime(s.firstSeenAt),
              age: stayed(s, now),
              back: s.reopenCount > 0 ? s.reopenCount : <span className="dim">—</span>,
              owner: s.ackedBy ?? <span className="dim">no one yet</span>,
              cleared: s.resolvedAt ? dateTime(s.resolvedAt) : "—",
              act: (
                <CanGate caps={["dispatch"]}>
                  <AcknowledgeSignalButton id={s.id} />
                </CanGate>
              )
            }
          }))}
        />
      )}
      {sentView ? null : <Pager page={list.page} pageSize={SIGNAL_PAGE_SIZE} total={list.total} hrefFor={(n) => query({ page: n })} newer="Earlier" older="Later" />}
    </>
  );
}
