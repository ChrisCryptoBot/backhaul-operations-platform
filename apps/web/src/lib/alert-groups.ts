import { RULES, type Alert, type AlertCode, type AlertLevel } from "./alerts";

/**
 * The alerts as a to-do list: the same problem on many loads is one line with its loads, and a truck or a driver on overlapping loads is one line for that truck or driver (the rules report it once for
 * every load in the clash, so three loads on one truck were three lines for one decision). Nothing is dropped and nothing is re-judged: every alert is in exactly one group, at its own level. PURE.
 */
export type AlertGroup = {
  key: string;
  level: AlertLevel;
  code: AlertCode;
  /** What is wrong, once. */
  title: string;
  /** The loads it is wrong on. `detail` is what this load's own alert says, when the loads do not all say the same. */
  loads: Array<{ key: string; loadId: string; loadNumber: string | null; detail: string | null }>;
};

const CLASH = new Set<string>(["DOUBLE_BOOKED", "TRUCK_DOUBLE_BOOKED"]);
const ORDER: Record<AlertLevel, number> = { block: 0, warn: 1, info: 2 };
const RULE_ORDER = new Map(RULES.map((r, i) => [r.code as string, i]));

/** "Unit 101 is also on DM-1, DM-2 at the same time." → the resource and the loads it names; null when a message is not worded that way (it then stands on its own). */
export function clashOf(message: string): { who: string; others: string[] } | null {
  const m = /^(.+?) is also (?:booked )?on (.+) at the same time\.$/.exec(message);
  return m ? { who: m[1]!, others: m[2]!.split(", ") } : null;
}

export function groupAlerts(alerts: Alert[]): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const line = (a: Alert, detail: string | null) => ({ key: a.key, loadId: a.loadId, loadNumber: a.loadNumber, detail });

  // Clashes: loads that name each other for the same resource are one group (joined through the load numbers the messages carry, so two drivers who share a name are not joined).
  const clashes = alerts.filter((a) => CLASH.has(a.code));
  const seen = new Set<Alert>();
  for (const a of clashes) {
    if (seen.has(a)) continue;
    const start = clashOf(a.message);
    const members: Alert[] = [];
    const queue = [a];
    while (queue.length > 0) {
      const x = queue.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      members.push(x);
      const c = clashOf(x.message);
      if (!c || x.loadNumber == null) continue;
      for (const y of clashes) {
        if (seen.has(y) || y.code !== a.code || y.loadNumber == null) continue;
        const d = clashOf(y.message);
        if (d && d.who === c.who && c.others.includes(y.loadNumber) && d.others.includes(x.loadNumber)) queue.push(y);
      }
    }
    members.sort((x, y) => (x.loadNumber ?? "").localeCompare(y.loadNumber ?? ""));
    groups.push({
      key: `${a.code}:${members[0]!.key}`,
      level: a.level,
      code: a.code,
      title: start && members.length > 1 ? `${start.who} is on ${members.length} overlapping loads` : a.message,
      loads: members.map((x) => line(x, null))
    });
  }

  // Everything else: one line for a rule at a level.
  const byRule = new Map<string, Alert[]>();
  for (const a of alerts) {
    if (CLASH.has(a.code)) continue;
    const k = `${a.level}:${a.code}`;
    byRule.set(k, [...(byRule.get(k) ?? []), a]);
  }
  for (const [k, list] of byRule) {
    const first = list[0]!;
    const same = list.every((a) => a.message === first.message);
    const rule = RULES.find((r) => r.code === first.code)?.title ?? first.code;
    groups.push({ key: k, level: first.level, code: first.code, title: same ? first.message : rule, loads: list.map((a) => line(a, same ? null : a.message)) });
  }
  return groups.sort((x, y) => ORDER[x.level] - ORDER[y.level] || (RULE_ORDER.get(x.code) ?? 99) - (RULE_ORDER.get(y.code) ?? 99) || (x.loads[0]?.loadNumber ?? "").localeCompare(y.loads[0]?.loadNumber ?? ""));
}
