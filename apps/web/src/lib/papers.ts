import { shortDate } from "./desk-format";

/**
 * A driver's or a trailer's dated papers in one cell: the one that runs out first, and whether that is a problem. Each paper keeps its own column too (folded until asked for) and its own line on the
 * unit's page; this is the one a dispatcher looks for. Display only: what blocks an assignment is decided on the server (clearance), never here.
 */
export type Paper = { name: string; expires: Date | null };
export type PapersCell = { tone: "ok" | "warn" | "bad" | "muted"; text: string; title: string };

const DAY = 86_400_000;
/** The same 30 days the alert rules warn at by default (ALERT_DEFAULTS.clearanceDays). */
export const PAPERS_SOON_DAYS = 30;

export function papersCell(papers: Paper[], now: Date, soonDays = PAPERS_SOON_DAYS): PapersCell {
  const line = (p: Paper) => (p.expires ? `${p.name} ${p.expires.getTime() < now.getTime() ? "lapsed" : "to"} ${shortDate(p.expires)}` : `${p.name} not on file`);
  const title = papers.map(line).join(" · ");
  const dated = papers.filter((p): p is { name: string; expires: Date } => p.expires != null).sort((a, b) => a.expires.getTime() - b.expires.getTime());
  const missing = papers.filter((p) => p.expires == null);
  const first = dated[0];
  if (first && first.expires.getTime() < now.getTime()) return { tone: "bad", text: line(first), title };
  // A paper nobody has entered is not a lapsed one and not a good one: it is said, and it outranks a date that is still far off.
  if (missing.length === papers.length) return { tone: "muted", text: "Not on file", title };
  if (missing.length > 0) return { tone: "warn", text: `${missing[0]!.name} not on file`, title };
  if (!first) return { tone: "muted", text: "Not on file", title };
  return { tone: first.expires.getTime() - now.getTime() <= soonDays * DAY ? "warn" : "ok", text: line(first), title };
}
