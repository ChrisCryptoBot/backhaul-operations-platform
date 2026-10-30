import { DESK_TZ } from "./zoned";

/** The most a message may hold. The same limit applies in the box, the action and the database write. */
export const MAX_BODY = 1000;

/** What the desk says about a message the dispatcher sent: nothing carries it to the driver's phone yet, so it is saved here and no more. */
export const SAVED_ONLY = "Saved on the desk";
export const SAVED_ONLY_NOTE = "Messages are saved on the desk. Nothing carries them to a driver's phone yet, so call or text a driver who needs an answer now.";

/** Ready-written lines a dispatcher can drop into the box and edit. */
export const CANNED = [
  "Are you on your way to the pickup?",
  "What is your ETA?",
  "Please send the delivery photos when you are done.",
  "Call me when you can.",
  "The pickup time moved. Check the load."
] as const;

export type CleanBody = { ok: true; body: string } | { ok: false; error: string };

/** Trim, refuse an empty or too-long message (empty is fine when the message carries a file), and flatten runs of blank lines. The browser's counter and the server both use this. */
export function cleanBody(raw: unknown, opts: { allowEmpty?: boolean } = {}): CleanBody {
  if (typeof raw !== "string") return opts.allowEmpty ? { ok: true, body: "" } : { ok: false, error: "Write a message first." };
  const body = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length === 0) return opts.allowEmpty ? { ok: true, body: "" } : { ok: false, error: "Write a message first." };
  if (body.length > MAX_BODY) return { ok: false, error: `That is ${body.length - MAX_BODY} characters over the ${MAX_BODY} limit.` };
  return { ok: true, body };
}

/** One line for a thread list: the start of the message, cut at a word, with an ellipsis when cut. */
export function snippet(body: string, max = 64): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: DESK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** "Today", "Yesterday" or "Oct 29", by the desk's own calendar (Central), never the browser's. */
export function dayLabel(d: Date, now: Date = new Date()): string {
  const key = ymd(d);
  if (key === ymd(now)) return "Today";
  if (key === ymd(new Date(now.getTime() - 24 * 3_600_000))) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: DESK_TZ });
}

export const timeLabel = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: DESK_TZ });

/** A thread list's stamp: the time today, "Yesterday", or the date. */
export function stamp(d: Date, now: Date = new Date()): string {
  const label = dayLabel(d, now);
  return label === "Today" ? timeLabel(d) : label;
}

/** Messages in the order they were sent, grouped under a day heading. */
export function groupByDay<T extends { sentAt: Date }>(messages: T[], now: Date = new Date()): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; key: string; items: T[] }> = [];
  for (const m of [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    const key = ymd(m.sentAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ day: dayLabel(m.sentAt, now), key, items: [m] });
  }
  return groups.map(({ day, items }) => ({ day, items }));
}
