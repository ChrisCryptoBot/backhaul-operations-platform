import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { recordAdvance, saveDeduction } from "@/server/tl/deductions";
import { finalizeSettlement, startSettlement, voidSettlement, type Draft } from "@/server/tl/settlement";
import { statementPdf, statementPdfData } from "@/server/tl/statement-pdf";

/**
 * The statement PDF on real statements (docs/MONEY_PLAN.md, Wave 4 step 6): the year to date from the frozen rows of the driver's finalized statements in the calendar year (through this one;
 * never a draft, a voided one or last year's), balances from the ledger, the stamps, and the download route's gate (terminal scope, sign-in) and headers.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/statement-pdf.integration.test.ts
 */
const state = vi.hoisted(() => ({ cookies: {} as Record<string, string>, terminal: null as string | null }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: (n: string) => (state.cookies[n] != null ? { value: state.cookies[n] } : undefined) }), headers: () => new Headers() }));
vi.mock("@/server/tl/terminal", () => ({ currentTerminal: async () => state.terminal }));

const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "stpdf-w";
const NOW = new Date("2026-11-12T18:00:00Z");
const noon = (d: string) => new Date(`${d}T17:00:00Z`);
const blank: Draft = { hours: {}, adjustments: [] };
const ENV = ["DESK_AUTH", "DESK_WORKSPACE_COOKIE"];
const saved: Record<string, string | undefined> = {};

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: W } });
  await prisma.settlement.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("the statement PDF", () => {
  let driverId = "";
  const st: Record<string, string> = {};

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.DESK_AUTH;
    process.env.DESK_WORKSPACE_COOKIE = "on";
    state.cookies = { "desk-workspace": W, "desk-demo": "accounting" };
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "PDF Fleet LLC", plan: "enterprise", mcNumber: "123456" } });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "Ana Ruiz", code: "ARUI", terminal: "Dallas", payrollWorkerType: "contractor" } })).id;
    // A $400 load a week ($0.50 a mile x 800).
    for (const [n, d] of [["P-1", "2026-10-06"], ["P-2", "2026-10-13"], ["P-3", "2026-10-20"], ["P-4", "2026-10-27"]] as const)
      await prisma.load.create({ data: { workspaceId: W, loadNumber: n, status: "completed", completedAt: noon(d), quotedRevenue: 2000, loadedMiles: 800, originAddress: "Dallas, TX", destinationAddress: "Austin, TX", assignment: { create: { driverId, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
    expect(await saveDeduction({ kind: "escrow", label: "Escrow", amount: "100", goal: "500" }, driverId, null, NOW, W)).toMatchObject({ ok: true });
    expect(await recordAdvance({ amount: "500", givenOn: "2026-10-01", method: "cash", repay: "150" }, driverId, NOW, W)).toMatchObject({ ok: true });
    // Last year's statement: never in this year's totals.
    await prisma.settlement.create({ data: { workspaceId: W, driverId, number: "ST-2025", status: "final", periodStart: new Date("2025-12-08"), periodEnd: new Date("2025-12-14"), total: 999, finalizedAt: noon("2025-12-20"), lineRows: { create: [{ workspaceId: W, sort: 0, kind: "load", label: "Old load", amount: 999 }] } } });
    const week = async (key: string, start: string, end: string, finalizeAt: string | null) => {
      const s = await startSettlement({ driverId, start, end }, NOW, W);
      if (!s.ok) throw new Error("no statement");
      st[key] = s.id;
      if (finalizeAt) expect(await finalizeSettlement(s.id, blank, noon(finalizeAt), W)).toMatchObject({ ok: true });
    };
    await week("w1", "2026-10-05", "2026-10-11", "2026-10-13");
    await week("w2", "2026-10-12", "2026-10-18", "2026-10-20");
    await week("w3", "2026-10-19", "2026-10-25", "2026-10-27");
    expect(await voidSettlement(st.w3!, "Wrong week", noon("2026-10-28"), W)).toMatchObject({ ok: true });
    await week("draft", "2026-10-26", "2026-11-01", null);
  });

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await wipe();
  });

  test("a final statement: its own figures, balances today, and the year to date through it", async () => {
    const d = (await statementPdfData(st.w2!, W, null, NOW))!;
    expect(d).toMatchObject({ number: expect.stringMatching(/^ST-/), status: "final", driver: { name: "Ana Ruiz", code: "ARUI" }, issuer: { name: "PDF Fleet LLC", mc: "123456" } });
    expect(d.statement).toMatchObject({ loadsTotal: 400, deductionsTotal: -250, total: 150 });
    expect(d.statement.deductions.map((x) => x.kind)).toEqual(["escrow", "advance_repaid"]);
    // Two finalized statements in 2026 (week 3 was voided; last year's does not count): $800 gross, $200 escrow, $300 repaid, $300 net.
    expect(d.ytd).toEqual({ year: 2026, statements: 2, grossCents: 80000, fuelCents: 0, adjustmentsOffCents: 0, deductionsCents: -20000, advancesRepaidCents: -30000, escrowReleasedCents: 0, netCents: 30000 });
    expect(d.balances).toEqual({ escrowHeldCents: 20000, advanceOwedCents: 20000, asOf: "Nov 12, 2026" });
    // The first week's year to date stops at itself.
    expect((await statementPdfData(st.w1!, W, null, NOW))!.ytd).toMatchObject({ statements: 1, grossCents: 40000, netCents: 15000 });
  });

  test("a voided statement and a draft are stamped and named so; neither counts in the year to date", async () => {
    const v = (await statementPdf(st.w3!, W, null, NOW))!;
    expect(v.filename).toMatch(/-VOID\.pdf$/);
    expect(v.data).toMatchObject({ status: "void", voidReason: "Wrong week" });
    expect(v.data.ytd).toMatchObject({ statements: 2 });
    const dr = (await statementPdf(st.draft!, W, null, NOW))!;
    expect(dr.filename).toMatch(/-DRAFT\.pdf$/);
    expect(dr.data.status).toBe("draft");
    expect(dr.data.ytd).toMatchObject({ statements: 2, netCents: 30000 });
    expect(Buffer.from(dr.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  test("outside the person's terminals it does not exist, as the page", async () => {
    expect(await statementPdfData(st.w2!, W, "Houston", NOW)).toBeNull();
    expect(await statementPdfData(st.w2!, W, "Dallas", NOW)).not.toBeNull();
    expect(await statementPdfData("nope", W, null, NOW)).toBeNull();
  });

  test("the route: the billing office only (403 for a viewer or a dispatcher), inside the terminals, and a file that is not cached or sniffed", async () => {
    const { GET } = await import("@/app/(desk)/settlements/[id]/pdf/route");
    const call = (id: string) => GET(new Request(`http://desk.test/settlements/${id}/pdf`), { params: { id } });
    state.terminal = null;
    const ok = await call(st.w2!);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("content-disposition")).toMatch(/^inline; filename="ST-\d+\.pdf"$/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await ok.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Driver pay is the billing office's: a viewer, a plain dispatcher and a driver manager are refused (403); accounting and an admin get the file.
    for (const role of ["viewer", "dispatcher", "driver_manager"]) {
      state.cookies["desk-demo"] = role;
      expect((await call(st.w2!)).status, role).toBe(403);
    }
    for (const role of ["accounting", "admin"]) {
      state.cookies["desk-demo"] = role;
      expect((await call(st.w2!)).status, role).toBe(200);
    }
    // Outside the chosen terminals: not found.
    state.terminal = "Houston";
    expect((await call(st.w2!)).status).toBe(404);
    state.terminal = null;
    // Another workspace's statement is not found from this one.
    state.cookies["desk-workspace"] = "demo-workspace";
    expect((await call(st.w2!)).status).toBe(404);
    state.cookies["desk-workspace"] = W;
    // With sign-in on and nobody signed in: refused before anything is read.
    process.env.DESK_AUTH = "on";
    expect((await call(st.w2!)).status).toBe(401);
    delete process.env.DESK_AUTH;
    state.cookies["desk-demo"] = "accounting";
  });
});
