import Link from "next/link";
import React from "react";
import { getAlertsInTerminal } from "@/server/tl/alerts";
import { currentTerminal } from "@/server/tl/terminal";
import { LEVEL_LABEL, RULES, type AlertLevel } from "@/lib/alerts";
import { PageHead, Tabs } from "@/components/desk/ui";
import { AlertList } from "@/components/desk/alert-bits";
import { AlertGroups } from "@/components/desk/alert-groups";
import { groupAlerts } from "@/lib/alert-groups";
import { EmptyState } from "@/components/desk/kit/states";
import { Pager } from "@/components/desk/pager";

export const metadata = { title: "Alerts · TrueLane" };

const LEVELS: AlertLevel[] = ["block", "warn", "info"];
const PAGE = 100;
const HEADING: Record<AlertLevel, string> = { block: "Fix before it goes out", warn: "Look at these soon", info: "For your information" };

export default async function AlertsPage({ searchParams }: { searchParams?: { level?: string; page?: string; code?: string } }) {
  // The header's terminal narrows the alerts too.
  const { alerts, counts, capped, cap } = await getAlertsInTerminal(await currentTerminal());
  const level = LEVELS.find((l) => l === searchParams?.level) ?? null;
  // One rule's alerts in full (from a line with more loads than it shows), or everything as a to-do list.
  const code = RULES.find((r) => r.code === searchParams?.code)?.code ?? null;
  const filtered = alerts.filter((a) => (!level || a.level === level) && (!code || a.code === code));
  const ordered = LEVELS.flatMap((l) => filtered.filter((a) => a.level === l));
  const groups = code ? [] : groupAlerts(ordered);
  const total = code ? ordered.length : groups.length;
  const page = Math.min(Math.max(1, Number(searchParams?.page) || 1), Math.max(1, Math.ceil(total / PAGE)));
  const shown = ordered.slice((page - 1) * PAGE, page * PAGE);
  const shownGroups = groups.slice((page - 1) * PAGE, page * PAGE);
  const pageHref = (n: number) => `/alerts?${new URLSearchParams({ ...(level ? { level } : {}), ...(code ? { code } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`;

  return (
    <>
      <PageHead title="Alerts" sub="What needs attention across the loads, each problem once with the loads it is on. Worked out each time you open this page; how long each has stayed is on Signals.">
        <Link href="/settings/rules" className="tl-btn ghost">How these are decided</Link>
      </PageHead>
      <Tabs
        active={level ?? "all"}
        hrefFor={(k) => (k === "all" ? "/alerts" : `/alerts?level=${k}`)}
        items={[{ key: "all", label: "All", count: alerts.length }, ...LEVELS.map((l) => ({ key: l, label: LEVEL_LABEL[l], count: counts[l] }))]}
      />
      {capped ? (
        <p className="tl-note warn" role="status">
          This list reads the {cap} newest delivered loads. There are at least that many, so an older delivery that was never invoiced may not be shown here. Invoice the oldest first, or find the rest under Loads, History.
        </p>
      ) : null}
      {ordered.length === 0 ? (
        <EmptyState icon="check" title="Nothing needs attention">Every open load has a driver where it needs one, and nothing is late.</EmptyState>
      ) : (
        LEVELS.filter((l) => (code ? shown.some((a) => a.level === l) : shownGroups.some((g) => g.level === l))).map((l) => (
          <section key={l} className="al-sec">
            <h2 className="t-sec">
              {HEADING[l]} · {code ? ordered.filter((a) => a.level === l).length : counts[l]}
            </h2>
            {code ? <AlertList alerts={shown.filter((a) => a.level === l)} withLoad /> : <AlertGroups groups={shownGroups.filter((g) => g.level === l)} allHref={(g) => `/alerts?level=${g.level}&code=${g.code}`} />}
          </section>
        ))
      )}
      {code ? (
        <p className="tl-note t-after">
          Only “{RULES.find((r) => r.code === code)!.title}”. <Link href={level ? `/alerts?level=${level}` : "/alerts"}>Every alert</Link>
        </p>
      ) : null}
      <Pager page={page} pageSize={PAGE} total={total} hrefFor={pageHref} newer="Earlier" older="Later" />
    </>
  );
}
