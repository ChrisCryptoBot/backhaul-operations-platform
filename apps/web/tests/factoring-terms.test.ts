import { describe, expect, test } from "vitest";
import { economicsOf, chargebackOf } from "@/lib/factoring-economics";
import { BLANK_TERMS, maskAccount, remitToOf, validateTerms } from "@/lib/factoring-terms";
import { scheduleCsv, splitReady, type ScheduleRow } from "@/lib/factoring-schedule";

describe("factoring terms", () => {
  test("a blank form is valid and saves nothing but the API transport", () => {
    const r = validateTerms(BLANK_TERMS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const { transport, ...rest } = r.value;
      expect(transport).toBe("api");
      expect(Object.values(rest).every((v) => v === null)).toBe(true);
    }
  });

  test("a batch needs a destination that fits its method; an API factor needs none", () => {
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_email", batchDestination: "" })).toMatchObject({ ok: false, errors: { batchDestination: expect.any(String) } });
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_email", batchDestination: "not-an-email" }).ok).toBe(false);
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_email", batchDestination: "batches@apex.example" })).toMatchObject({ ok: true, value: { transport: "batch", batchMethod: "email", batchDestination: "batches@apex.example" } });
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_sftp", batchDestination: "ftp://wrong" }).ok).toBe(false);
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_sftp", batchDestination: "sftp://files.apex.example:2222/inbox" })).toMatchObject({ ok: true, value: { batchMethod: "sftp" } });
    expect(validateTerms({ ...BLANK_TERMS, transport: "batch_sftp", batchDestination: "files.apex.example:/inbox" }).ok).toBe(true);
    // A destination typed while "API" is chosen is not kept.
    expect(validateTerms({ ...BLANK_TERMS, transport: "api", batchDestination: "x" })).toMatchObject({ ok: true, value: { transport: "api", batchMethod: null, batchDestination: null } });
  });

  test("routing is nine digits, the account 4 to 17, percentages 0 to 100 with two decimals", () => {
    const bad = validateTerms({ ...BLANK_TERMS, routingNumber: "12345", accountNumber: "12", advancePct: "101", feePct: "2.555" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["accountNumber", "advancePct", "feePct", "routingNumber"]);
    const good = validateTerms({ ...BLANK_TERMS, routingNumber: "111 000 025", accountNumber: "1234-5678", advancePct: "90%", feePct: "2.5" });
    expect(good.ok && good.value).toMatchObject({ routingNumber: "111000025", accountNumber: "12345678", advancePct: "90", feePct: "2.5" });
    expect(validateTerms({ ...BLANK_TERMS, advancePct: "100.5" }).ok).toBe(false);
    expect(validateTerms({ ...BLANK_TERMS, advancePct: "100" }).ok).toBe(true);
  });

  test("the remit-to reads as one line with the lockbox bank, and nothing on file is null", () => {
    expect(remitToOf(null)).toBeNull();
    expect(remitToOf({ remitName: null, remitAddress: null, lockboxBank: null, routingNumber: null, accountNumber: null })).toBeNull();
    expect(remitToOf({ remitName: "Apex Capital", remitAddress: "PO Box 100\nDallas, TX 75201", lockboxBank: "Bank of Dallas", routingNumber: "111000025", accountNumber: "12345678" })).toBe(
      "Apex Capital. PO Box 100, Dallas, TX 75201. Bank of Dallas, routing 111000025, account 12345678"
    );
    expect(maskAccount("12345678")).toBe("****5678");
    expect(maskAccount(null)).toBeNull();
  });
});

describe("factoring economics", () => {
  test("a 90% advance and 2.5% fee on $1,000.00: $900 up front, $100 held, $25 fee, $75 released, $975 in all", () => {
    expect(economicsOf(1000, { advancePct: 90, feePct: 2.5 })).toEqual({ advance: 900, reserveHeld: 100, fee: 25, reserveReleasable: 75, netToCarrier: 975 });
  });

  test("cents are rounded once and the parts add up", () => {
    const e = economicsOf("1491.00", { advancePct: "92.5", feePct: "3.15" })!;
    expect(e.advance).toBe(1379.18);
    expect(e.advance + e.reserveHeld).toBeCloseTo(1491, 2);
    expect(e.fee).toBe(46.97);
    expect(e.netToCarrier).toBeCloseTo(e.advance + e.reserveReleasable, 2);
  });

  test("a fee larger than the reserve leaves nothing to release, never a negative", () => {
    expect(economicsOf(1000, { advancePct: 99, feePct: 3 })).toMatchObject({ reserveHeld: 10, fee: 30, reserveReleasable: 0, netToCarrier: 990 });
  });

  test("no advance rate means nothing can be worked out; no fee rate is a fee of zero; a chargeback is the advance", () => {
    expect(economicsOf(1000, { advancePct: null, feePct: 2 })).toBeNull();
    expect(economicsOf(1000, { advancePct: 80, feePct: null })).toMatchObject({ fee: 0, reserveReleasable: 200 });
    expect(chargebackOf("900.00")).toBe(900);
  });
});

describe("the schedule of accounts", () => {
  const row = (over: Partial<ScheduleRow>): ScheduleRow => ({ number: "INV-1", loads: "L-1", customer: "Acme", mc: "123", po: "PO1", issued: "2026-11-12", due: "2026-12-12", termsDays: 30, amount: 1000, balance: 1000, rateCon: true, pod: true, reference: null, ...over });

  test("one row per invoice with the documents on file, and a text cell that looks like a formula is made safe", () => {
    const csv = scheduleCsv([row({}), row({ number: "INV-2", customer: "=HYPERLINK(x)", rateCon: false })]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("Invoice,Loads,Customer,Customer MC,PO,Invoice date,Due date,Terms (days),Amount,Balance,Rate confirmation on file,Proof of delivery on file,Factor reference");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("'=HYPERLINK(x)");
    expect(lines[2]).toContain(",no,yes,");
  });

  test("an invoice goes out only with its rate confirmation and proof of delivery; the others are held and say what they lack", () => {
    const { ready, held } = splitReady([row({}), row({ number: "INV-2", pod: false }), row({ number: "INV-3", rateCon: false, pod: false })]);
    expect(ready.map((r) => r.number)).toEqual(["INV-1"]);
    expect(held.map((h) => [h.row.number, h.lacks])).toEqual([["INV-2", ["proof of delivery"]], ["INV-3", ["rate confirmation", "proof of delivery"]]]);
  });
});
