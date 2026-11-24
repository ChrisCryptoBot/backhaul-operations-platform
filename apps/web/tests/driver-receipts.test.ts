import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bridgeState, reimbursedLabel, RECEIPT_KINDS, takeable, type BridgeReceiptRow } from "@/lib/driver-receipts";
import { classifyLine } from "@/lib/form1099";
import { computeStatement, isNetPay, rowsTotalCents, statementOf, statementRows } from "@/lib/settlement";
import { ytdFromRows } from "@/lib/statement-pdf";

/** Sync plan Step 5b: receipts, and what one does to a statement. */
const SQL = readFileSync(join(__dirname, "../../../../supabase/migrations/20261122000600_bridge_driver_receipts.sql"), "utf8");
const DESK_SQL = readFileSync(join(__dirname, "../../../prisma/migrations/20270110000000_driver_receipts/migration.sql"), "utf8");

const load = { loadId: "L1", loadNumber: "DM-1", origin: "A", destination: "B", deliveredAt: "2026-11-10T00:00:00Z", loadedMiles: 400, payKind: "cpm" as const, payRate: 0.5, rateConTotal: 1000, assignedHours: null, brokerStatus: "paid" as const };
const back = [{ receiptId: "r1", label: "Reimbursed: Tolls, Nov 12", amount: 42.5 }];

describe("a receipt paid back on a statement", () => {
  const st = computeStatement({ loads: [load], hours: {}, adjustments: [{ label: "Bonus", amount: "10" }], reimbursements: back });

  test("adds to the total as its own kind of row, and the rows still come to the total", () => {
    expect(st.total).toBe(252.5);
    const rows = statementRows(st);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([["load", 200], ["adjustment", 10], ["reimbursement", 42.5]]);
    expect(new Set(rows.map((r) => r.sort)).size).toBe(rows.length);
    expect(rowsTotalCents(rows)).toBe(25250);
  });

  test("is money back, never pay: not in 1099 gross, not in the year's pay, and the year still adds up", () => {
    expect(classifyLine("reimbursement", 4250)).toBe("pass");
    const y = ytdFromRows(2026, 1, statementRows(st).map((r) => ({ kind: r.kind, cents: Math.round(r.amount * 100) })));
    expect([y.grossCents, y.reimbursedCents, y.netCents]).toEqual([21000, 4250, 25250]);
    expect(isNetPay(st)).toBe(false);
    expect(st.cautions.some((c) => c.includes("$42.50") && c.includes("not wages"))).toBe(true);
  });

  test("frozen and read back, it is still the same", () => {
    const again = statementOf(st.lines, st.adjustments);
    expect(again.total).toBe(252.5);
    expect(statementRows(again).map((r) => r.kind)).toEqual(["load", "adjustment", "reimbursement"]);
  });

  test("a statement without one is exactly as it was", () => {
    const plain = computeStatement({ loads: [load], hours: {}, adjustments: [] });
    expect(plain.adjustments).toEqual([]);
    expect(plain.cautions.some((c) => c.includes("wages"))).toBe(false);
  });
});

describe("what the desk takes and tells", () => {
  const row = (o: Partial<BridgeReceiptRow> = {}): BridgeReceiptRow => ({ id: "b1", org_id: "o", driver_sub: "u", amount_cents: 4250, kind: "tolls", spent_on: "2026-11-12", note: null, source_load_id: null, path: "org/o/driver/u/rcpt-1.jpg", state: "submitted", reason: null, statement_number: null, taken_at: null, created_at: "2026-11-12T10:00:00Z", ...o });

  test("only its own fleet's, with an amount and a kind it knows", () => {
    expect(takeable(row(), "o")).toBe(true);
    for (const bad of [row({ org_id: "x" }), row({ amount_cents: 0 }), row({ amount_cents: 1_000_001 }), row({ amount_cents: 1.5 }), row({ kind: "gift" }), row({ spent_on: "11/12" })]) expect(takeable(bad, "o")).toBe(false);
  });

  test("the state the driver reads", () => {
    const s = (state: string, settlement: { number: string; paidAt: Date | null } | null = null) => bridgeState({ state, reason: "no", settlement });
    expect([s("submitted").state, s("approved").state, s("declined").state, s("approved", { number: "ST-1", paidAt: null }).state, s("approved", { number: "ST-1", paidAt: new Date() }).state]).toEqual(["submitted", "approved", "declined", "settled", "paid"]);
    expect([s("declined").reason, s("approved").reason, s("approved", { number: "ST-1", paidAt: null }).statement_number]).toEqual(["no", null, "ST-1"]);
    expect(reimbursedLabel({ kind: "tolls", spentOn: "2026-11-12" })).toBe("Reimbursed: Tolls, Nov 12");
  });

  test("the kinds are the same here, in the desk's database and in the phone project's", () => {
    const list = RECEIPT_KINDS.map((k) => `'${k}'`).join(", ");
    expect(SQL).toContain(`check (kind in (${list}))`);
    expect(DESK_SQL).toContain(`CHECK ("kind" IN (${list}))`);
  });
});
