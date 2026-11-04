import { describe, expect, it } from "vitest";
import { daysPastDue, deskDaysBetween, dueAt, isOverdue } from "../src/lib/overdue";
import { RESERVED_LABELS, revisedInvoiceNumber, termsLabel, validateInvoice } from "../src/lib/invoicing";

/** The overdue rule reads the desk's own calendar (Dallas), never the server's: these instants mean the same on any host. */
describe("when an invoice is late, on the Dallas calendar", () => {
  // Sent the evening of Feb 28 in Dallas (22:00 CST), which is already March 1 in UTC.
  const sent = new Date("2026-03-01T04:00:00Z");
  it("is due on the same clock time N calendar days on, across the change of clocks", () => {
    const due = dueAt(sent, 30)!;
    // Mar 30, 22:00 in Dallas is CDT, so 03:00Z the next day: an hour short of 30 x 24 h.
    expect(due.toISOString()).toBe("2026-03-31T03:00:00.000Z");
  });
  it("is not late on its due day, even late in the evening, and is late from the next Dallas day", () => {
    expect(daysPastDue(sent, 30, new Date("2026-03-31T04:30:00Z"))).toBe(0); // 23:30 on Mar 30 in Dallas, though already Mar 31 in UTC
    expect(isOverdue(sent, 30, new Date("2026-03-31T04:30:00Z"))).toBe(false);
    expect(daysPastDue(sent, 30, new Date("2026-03-31T05:30:00Z"))).toBe(1); // 00:30 on Mar 31 in Dallas
    expect(isOverdue(sent, 30, new Date("2026-03-31T05:30:00Z"))).toBe(true);
  });
  it("counts whole Dallas days between two moments, signed", () => {
    expect(deskDaysBetween(new Date("2026-10-31T04:00:00Z"), new Date("2026-11-02T04:30:00Z"))).toBe(2);
    expect(deskDaysBetween(new Date("2026-11-02T04:30:00Z"), new Date("2026-10-31T04:00:00Z"))).toBe(-2);
  });
  it("is due the day it was sent for terms of 0 (due on receipt), and has no answer without an invoice date", () => {
    expect(daysPastDue(sent, 0, new Date("2026-03-01T05:00:00Z"))).toBe(0); // 23:00 on Feb 28 in Dallas, the day it was sent
    expect(daysPastDue(sent, 0, new Date("2026-03-01T20:00:00Z"))).toBe(1); // the next day in Dallas
    expect(dueAt(null, 30)).toBeNull();
    expect(isOverdue(null, 30)).toBe(false);
  });
});

describe("terms in words", () => {
  it("says due on receipt for 0 days", () => {
    expect(termsLabel(0)).toBe("Due on receipt");
    expect(termsLabel(30)).toBe("Net 30");
    expect(termsLabel(null)).toBe("Net 0");
  });
});

describe("a number for the invoice made again", () => {
  it("is the load's own until it has been sent and taken back, then the next revision", () => {
    expect(revisedInvoiceNumber("INV-1234", new Set())).toBe("INV-1234");
    expect(revisedInvoiceNumber("INV-1234", new Set(["INV-1234"]))).toBe("INV-1234-2");
    expect(revisedInvoiceNumber("INV-1234", new Set(["INV-1234", "INV-1234-2"]))).toBe("INV-1234-3");
    expect(revisedInvoiceNumber("INV-1234", new Set(["INV-1234-2"]))).toBe("INV-1234");
  });
});

describe("an extra charge cannot take a line's own name", () => {
  const ctx = { rate: 1000, surcharge: 0, detention: 0, defaultTerms: 30 };
  const form = (otherLabel: string) => ({ number: "INV-1", terms: "", detention: false, lumper: "", layover: "", otherLabel, other: "50" });
  it.each(RESERVED_LABELS)("refuses %s", (label) => {
    for (const v of [label, label.toUpperCase(), ` ${label} `]) expect(validateInvoice(form(v), ctx)).toMatchObject({ ok: false, errors: { otherLabel: expect.stringContaining("already a line") } });
  });
  it("accepts another name", () => {
    expect(validateInvoice(form("Pallet jack rental"), ctx)).toMatchObject({ ok: true });
  });
});
