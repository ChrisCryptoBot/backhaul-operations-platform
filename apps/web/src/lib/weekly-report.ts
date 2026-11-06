import { LEVEL_LABEL, type AlertLevel } from "./alerts";
import { deskLink, escapeHtml, moneyText, type Notice } from "./notify";
import type { SignalSettings } from "./signal-settings";

/**
 * The weekly report: one short message a week, built from figures the desk already works out (the last four weeks' headline, the Leak Ledger, Data health, the signals). It adds no sum of its own: it
 * lines up what those screens say, so a person who opens any of them finds the same number. Pure shaping and timing; the figures come from server/tl/weekly-report.ts.
 */
export type WeeklyReport = {
  /** The local ISO week this report is for ("2026-W45"): once per week. */
  weekKey: string;
  asOf: number;
  windowLabel: string;
  headline: { loads: number; gross: number; rpm: number | null; emptyShare: number | null };
  leaks: { total: number; items: number; unpriced: number; lines: Array<{ label: string; dollars: number; items: number }>; openDwellDollars: number; openDwellTrailers: number };
  health: { score: number | null; gaps: Array<{ label: string; gaps: number }> };
  signals: { open: Record<AlertLevel, number>; acknowledged: number; oldestOpenDays: number | null; newThisWeek: number; clearedThisWeek: number };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The carrier's own date and clock at an instant: year, month, day, hour, and the weekday (0 = Sunday). */
export function localParts(ms: number, tz: string): { y: number; m: number; d: number; hour: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour) % 24, weekday };
}

/** The ISO week (Monday first, the week with the year's first Thursday is week 1) of a calendar date. */
export function isoWeekOf(y: number, m: number, d: number): { year: number; week: number } {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // the Thursday of this week
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { year, week };
}

export const weekKeyAt = (ms: number, tz: string): string => {
  const l = localParts(ms, tz);
  const w = isoWeekOf(l.y, l.m, l.d);
  return `${w.year}-W${pad(w.week)}`;
};

/**
 * Whether this week's report is due: it is on, and the carrier's clock has reached the day and hour it was set for, counting the week from Monday (so a Sunday report is the last of its week). A run that
 * comes late (a missed schedule) still sends it later in the same week; the week key stops a second one.
 */
export function reportDue(s: Pick<SignalSettings, "reportEnabled" | "reportDay" | "reportHour">, ms: number, tz: string): { due: boolean; weekKey: string } {
  const l = localParts(ms, tz);
  const w = isoWeekOf(l.y, l.m, l.d);
  const weekKey = `${w.year}-W${pad(w.week)}`;
  if (!s.reportEnabled) return { due: false, weekKey };
  const nowSlot = ((l.weekday + 6) % 7) * 24 + l.hour;
  const dueSlot = ((s.reportDay + 6) % 7) * 24 + s.reportHour;
  return { due: nowSlot >= dueSlot, weekKey };
}

const pct = (v: number | null) => (v == null ? "no figure" : `${(v * 100).toFixed(1)}%`);

/** The report as a notice: the words for a person, and the facts for a workflow. */
export function reportNotice(r: WeeklyReport, deskUrl: string | null): Notice {
  const lines: string[] = [];
  lines.push(`${r.windowLabel}: ${r.headline.loads} finished ${r.headline.loads === 1 ? "load" : "loads"}, ${moneyText(r.headline.gross)} gross${r.headline.rpm != null ? `, ${moneyText(r.headline.rpm)} a mile` : ""}, ${pct(r.headline.emptyShare)} empty miles.`);
  const l = r.leaks;
  lines.push(l.items === 0 ? "Leak Ledger: nothing leaked in the period." : `Leak Ledger: ${moneyText(l.total)} across ${l.items} ${l.items === 1 ? "item" : "items"}${l.unpriced > 0 ? ` (${l.unpriced} with no price yet)` : ""}.`);
  for (const x of l.lines.slice(0, 4)) lines.push(`  ${x.label}: ${moneyText(x.dollars)} (${x.items})`);
  if (l.openDwellTrailers > 0) lines.push(`  Trailers waiting right now: ${l.openDwellTrailers}, ${moneyText(l.openDwellDollars)} owed and not billed.`);
  lines.push(r.health.score == null ? "Data health: nothing to check yet." : `Data health: ${Math.round(r.health.score)} out of 100.`);
  for (const g of r.health.gaps.slice(0, 3)) lines.push(`  ${g.label}: ${g.gaps} ${g.gaps === 1 ? "gap" : "gaps"}`);
  const s = r.signals;
  const open = s.open.block + s.open.warn + s.open.info;
  lines.push(`Signals: ${open} open (${s.open.block} ${LEVEL_LABEL.block.toLowerCase()}, ${s.open.warn} ${LEVEL_LABEL.warn.toLowerCase()}, ${s.open.info} ${LEVEL_LABEL.info.toLowerCase()}), ${s.acknowledged} acknowledged; ${s.newThisWeek} new and ${s.clearedThisWeek} cleared this week${s.oldestOpenDays != null ? `; the oldest open one is ${s.oldestOpenDays} ${s.oldestOpenDays === 1 ? "day" : "days"} old` : ""}.`);
  const link = deskLink(deskUrl, "/signals");
  if (link) lines.push(`Open: ${link}`);
  const text = lines.join("\n");
  const html = lines.map((x) => (x.startsWith("  ") ? `<div style="margin-left:16px">${escapeHtml(x.trim())}</div>` : `<p>${escapeHtml(x)}</p>`)).join("");
  return {
    kind: "weekly_report",
    subject: `Weekly report, ${r.weekKey}: ${open} open ${open === 1 ? "signal" : "signals"}, ${moneyText(l.total)} leaked`,
    text,
    html,
    dedupeKey: `report:${r.weekKey}`,
    level: null,
    loadNumber: null,
    unit: null,
    dollars: l.total,
    deskUrl: link,
    data: { weekKey: r.weekKey, asOf: new Date(r.asOf).toISOString(), report: r }
  };
}
