import { LEVEL_LABEL, type AlertLevel } from "./alerts";

/**
 * What the desk sends, as data (docs/SIGNALS.md). A notice is one thing to tell people: a signal that needs them, or the weekly report. It carries the words (subject, text, html) AND the facts, so a
 * workflow on the other end (n8n, a Slack block, an SMS) can format it any way it likes instead of parsing a sentence. Pure: nothing here reads a clock, a database or the network.
 */
export type NoticeKind = "signal" | "weekly_report";

export type Notice = {
  kind: NoticeKind;
  subject: string;
  text: string;
  /** A small, plain HTML version for email. */
  html: string;
  /** What makes this one unique, before the channel is added: a signal at a level on a return, or a report week. */
  dedupeKey: string;
  level: AlertLevel | null;
  /** The facts a workflow formats from. `dollars` is the load's billed or earned figure for a money signal and null otherwise (never guessed). */
  loadNumber: string | null;
  unit: string | null;
  dollars: number | null;
  deskUrl: string | null;
  /** Everything else, in plain values. */
  data: Record<string, unknown>;
};

/** The five tries a notification gets: a minute, five, half an hour, two hours, then it is left failed. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MINUTES = [1, 5, 30, 120] as const;
/** How long a claimed send is held before another run may take it again (a send that died mid-way). */
export const LEASE_MINUTES = 3;

/** When the next try is due after `attempts` tries have failed, or null when the tries are used up. */
export function nextTryAfter(attempts: number, now: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const mins = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!;
  return now + mins * 60_000;
}

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Money in words for a message: "$1,250" (cents only when there are some). */
export function moneyText(n: number): string {
  const cents = Math.round(n * 100) % 100 !== 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

/** The address of a path on the desk, from the desk's own address (no trailing slash); null when the address is not known. */
export function deskLink(base: string | null | undefined, path: string): string | null {
  const b = (base ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(b) ? `${b}${path}` : null;
}

export type SignalFacts = {
  id: string;
  key: string;
  code: string;
  level: AlertLevel;
  title: string;
  detail: string;
  loadId: string | null;
  loadNumber: string | null;
  unit: string | null;
  dollars: number | null;
  firstSeenAt: number;
  reopenCount: number;
  deskUrl: string | null;
};

/** The notice for one signal at the level it has now. A signal that clears and returns is a new notice (the return count is in the key). */
export function signalNotice(f: SignalFacts): Notice {
  const where = [f.loadNumber, f.unit ? `unit ${f.unit}` : null].filter(Boolean).join(", ");
  const subject = `${LEVEL_LABEL[f.level]}: ${f.detail}${f.loadNumber ? ` (${f.loadNumber})` : ""}`.slice(0, 200);
  const link = f.loadId ? deskLink(f.deskUrl, `/loads/${f.loadId}`) : deskLink(f.deskUrl, "/signals");
  const text = [`${LEVEL_LABEL[f.level]}: ${f.detail}`, where ? `Where: ${where}` : null, f.dollars != null ? `Amount: ${moneyText(f.dollars)}` : null, `Rule: ${f.title}`, link ? `Open: ${link}` : null].filter(Boolean).join("\n");
  const html = [`<p><strong>${escapeHtml(LEVEL_LABEL[f.level])}</strong>: ${escapeHtml(f.detail)}</p>`, where ? `<p>Where: ${escapeHtml(where)}</p>` : "", f.dollars != null ? `<p>Amount: ${escapeHtml(moneyText(f.dollars))}</p>` : "", `<p>Rule: ${escapeHtml(f.title)}</p>`, link ? `<p><a href="${escapeHtml(link)}">Open it on the desk</a></p>` : ""].join("");
  return {
    kind: "signal",
    subject,
    text,
    html,
    dedupeKey: `signal:${f.id}:${f.reopenCount}:${f.level}`,
    level: f.level,
    loadNumber: f.loadNumber,
    unit: f.unit,
    dollars: f.dollars,
    deskUrl: link,
    data: { signalId: f.id, key: f.key, code: f.code, title: f.title, detail: f.detail, loadId: f.loadId, firstSeenAt: new Date(f.firstSeenAt).toISOString(), reopenCount: f.reopenCount }
  };
}

/** What goes over a webhook: the notice as one flat JSON object, the four facts a workflow formats from at the top. */
export function webhookPayload(n: Notice): Record<string, unknown> {
  return { kind: n.kind, dedupeKey: n.dedupeKey, level: n.level, subject: n.subject, text: n.text, html: n.html, loadNumber: n.loadNumber, unit: n.unit, dollars: n.dollars, deskUrl: n.deskUrl, data: n.data };
}

/** Which money signals carry a dollar figure, and from which of the load's figures (never a guess: any other signal has none). */
export const DOLLAR_RULES: Readonly<Record<string, "invoice" | "earned">> = { INVOICE_OVERDUE: "invoice", READY_TO_INVOICE: "earned" };

export type LoadMoney = { invoicedAmount: number | null; actualRevenue: number | null; quotedRevenue: number | null };

export function dollarsOf(code: string, m: LoadMoney | null): number | null {
  const rule = DOLLAR_RULES[code];
  if (!rule || !m) return null;
  const v = rule === "invoice" ? (m.invoicedAmount ?? m.actualRevenue) : (m.actualRevenue ?? m.quotedRevenue);
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}
