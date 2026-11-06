import { describe, expect, test } from "vitest";
import { BACKOFF_MINUTES, MAX_ATTEMPTS, deskLink, dollarsOf, escapeHtml, moneyText, nextTryAfter, signalNotice, webhookPayload, type SignalFacts } from "@/lib/notify";

const facts = (over: Partial<SignalFacts> = {}): SignalFacts => ({ id: "s1", key: "l1:INVOICE_OVERDUE", code: "INVOICE_OVERDUE", level: "block", title: "Invoice is past its terms", detail: "Invoice 1042 is 12 days past due.", loadId: "l1", loadNumber: "DM-40002", unit: "101", dollars: 1250, firstSeenAt: Date.UTC(2026, 10, 1), reopenCount: 0, deskUrl: "https://desk.example.com/", ...over });

describe("the notice for a signal", () => {
  test("says what, where and how much, with a link to the load; the facts are fields, not only a sentence", () => {
    const n = signalNotice(facts());
    expect(n.subject).toBe("Block: Invoice 1042 is 12 days past due. (DM-40002)");
    expect(n.text).toBe(["Block: Invoice 1042 is 12 days past due.", "Where: DM-40002, unit 101", "Amount: $1,250", "Rule: Invoice is past its terms", "Open: https://desk.example.com/loads/l1"].join("\n"));
    expect(n).toMatchObject({ kind: "signal", level: "block", loadNumber: "DM-40002", unit: "101", dollars: 1250, deskUrl: "https://desk.example.com/loads/l1" });
    expect(n.data).toMatchObject({ signalId: "s1", code: "INVOICE_OVERDUE", loadId: "l1", reopenCount: 0, firstSeenAt: "2026-11-01T00:00:00.000Z" });
  });

  test("the flat webhook payload has the four facts a workflow formats from at the top", () => {
    const p = webhookPayload(signalNotice(facts()));
    expect(Object.keys(p)).toEqual(["kind", "dedupeKey", "level", "subject", "text", "html", "loadNumber", "unit", "dollars", "deskUrl", "data"]);
    expect(p).toMatchObject({ loadNumber: "DM-40002", unit: "101", dollars: 1250, deskUrl: "https://desk.example.com/loads/l1" });
  });

  test("no amount, no unit, no address: those parts are left out of the words and are null in the fields", () => {
    const n = signalNotice(facts({ dollars: null, unit: null, deskUrl: null }));
    expect(n.text).not.toMatch(/Amount|unit|Open:/);
    expect(n).toMatchObject({ dollars: null, unit: null, deskUrl: null });
  });

  test("a signal that clears and returns, or gets worse, is a different notice; the same one is the same key", () => {
    expect(signalNotice(facts()).dedupeKey).toBe("signal:s1:0:block");
    expect(signalNotice(facts()).dedupeKey).toBe(signalNotice(facts()).dedupeKey);
    expect(signalNotice(facts({ reopenCount: 1 })).dedupeKey).not.toBe(signalNotice(facts()).dedupeKey);
    expect(signalNotice(facts({ level: "warn" })).dedupeKey).not.toBe(signalNotice(facts()).dedupeKey);
  });

  test("words typed by someone else cannot break the email's markup", () => {
    const n = signalNotice(facts({ detail: `<b onclick="x">Bob & "co"</b>`, loadNumber: "<i>" }));
    expect(n.html).not.toContain("<b onclick");
    expect(n.html).toContain("&lt;b onclick=&quot;x&quot;&gt;Bob &amp; &quot;co&quot;&lt;/b&gt;");
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
  });
});

describe("amounts", () => {
  test("only the two money rules carry a dollar figure, from the right one of the load's figures", () => {
    const m = { invoicedAmount: 900, actualRevenue: 1000, quotedRevenue: 800 };
    expect(dollarsOf("INVOICE_OVERDUE", m)).toBe(900);
    expect(dollarsOf("INVOICE_OVERDUE", { ...m, invoicedAmount: null })).toBe(1000);
    expect(dollarsOf("READY_TO_INVOICE", m)).toBe(1000);
    expect(dollarsOf("READY_TO_INVOICE", { ...m, actualRevenue: null })).toBe(800);
    expect(dollarsOf("NO_TRUCK", m)).toBeNull();
    expect(dollarsOf("INVOICE_OVERDUE", null)).toBeNull();
    expect(dollarsOf("INVOICE_OVERDUE", { invoicedAmount: 0, actualRevenue: null, quotedRevenue: null })).toBeNull();
  });
  test("money in words and the desk's links", () => {
    expect(moneyText(1250)).toBe("$1,250");
    expect(moneyText(1250.5)).toBe("$1,250.50");
    expect(deskLink("https://d.example.com//", "/signals")).toBe("https://d.example.com/signals");
    expect(deskLink("desk.example.com", "/signals")).toBeNull();
    expect(deskLink(null, "/signals")).toBeNull();
  });
});

describe("retries", () => {
  test("a minute, five, half an hour, two hours, then the tries are used up", () => {
    const t = 1_000_000;
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120]);
    expect(nextTryAfter(1, t)).toBe(t + 60_000);
    expect(nextTryAfter(2, t)).toBe(t + 5 * 60_000);
    expect(nextTryAfter(3, t)).toBe(t + 30 * 60_000);
    expect(nextTryAfter(4, t)).toBe(t + 120 * 60_000);
    expect(nextTryAfter(MAX_ATTEMPTS, t)).toBeNull();
  });
});
