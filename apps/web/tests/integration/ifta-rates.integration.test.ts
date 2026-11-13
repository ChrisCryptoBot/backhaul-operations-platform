import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearIftaRates, commitIftaRates, iftaRateQuarters, listIftaRates, loadSampleIftaRates, previewIftaRates } from "@/server/partners/ifta-rates";

/**
 * Wave 5 step 4: a quarter's IFTA rates from a file. A file replaces its whole quarter (other quarters and other workspaces untouched), rate and surcharge stay apart, Canadian rows are counted
 * and skipped, sample rates never land over real ones, one audit event per write. A workspace of its own:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo_test RUN_DB_INTEGRATION=true npx vitest run tests/integration/ifta-rates.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "irate-w";
const OTHER = "irate-other";
const NOW = new Date("2026-11-13T15:00:00Z");
const Q = "2026-Q3";

async function wipe() {
  for (const id of [W, OTHER]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

const FILE = ["Jurisdiction,Diesel,Surcharge", "Texas,0.20,", "Kentucky,0.246,", "Kentucky Surcharge,0.102,", "Indiana,0.55,0.12", "Ontario,0.143,", "Narnia,0.3,", "DC,0.235,"].join("\n");
const audits = (action: string) => prisma.auditEvent.findMany({ where: { workspaceId: W, action }, orderBy: { createdAt: "asc" } });

describe.skipIf(!run)("IFTA rates from a file", () => {
  beforeAll(async () => {
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "IRATE desk", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "IRATE other", plan: "enterprise" } });
  });
  afterAll(wipe);

  test("every entry point checks the quarter's shape", async () => {
    for (const bad of ["2026Q3", "2026-Q5", "", "2026-Q3; drop"]) {
      expect(await previewIftaRates(FILE, null, bad, "final", W)).toEqual({ ok: false, error: "A quarter, like 2026-Q3." });
      expect(await commitIftaRates(FILE, null, bad, "final", "x.csv", NOW, W)).toEqual({ ok: false, error: "A quarter, like 2026-Q3." });
      expect(await loadSampleIftaRates(bad, NOW, W)).toEqual({ ok: false, error: "A quarter, like 2026-Q3." });
      expect(await clearIftaRates(bad, NOW, W)).toEqual({ ok: false, error: "A quarter, like 2026-Q3." });
    }
    // The database refuses one too, whatever the code does.
    await expect(prisma.iftaRate.create({ data: { workspaceId: W, quarter: "2026Q3", jurisdiction: "TX", rate: 0.2, status: "final" } })).rejects.toThrow();
    await expect(prisma.iftaRate.create({ data: { workspaceId: W, quarter: Q, jurisdiction: "ON", rate: 0.2, status: "final" } })).rejects.toThrow();
    await expect(prisma.iftaRate.create({ data: { workspaceId: W, quarter: Q, jurisdiction: "TX", rate: -0.1, status: "final" } })).rejects.toThrow();
    expect(await prisma.iftaRate.count({ where: { workspaceId: W } })).toBe(0);
  });

  test("the preview reads every row and writes nothing", async () => {
    const p = await previewIftaRates(FILE, null, Q, "final", W);
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ total: 7, ready: 4, canada: 1, problemCount: 1, duplicates: 0, missing: [], replaces: { count: 0 } });
    expect(p.problems[0]).toMatchObject({ line: 7 });
    expect(p.rates.find((r) => r.jurisdiction === "KY")).toMatchObject({ rate: "0.2460", surcharge: "0.1020", status: "final", surchargeLine: 4 });
    expect(p.notInFile).toHaveLength(47);
    expect(await prisma.iftaRate.count({ where: { workspaceId: W } })).toBe(0);
  });

  test("sample rates load over nothing, labelled; loading again refreshes them", async () => {
    const s = await loadSampleIftaRates(Q, NOW, W);
    expect(s).toEqual({ ok: true, created: 48 });
    expect(await loadSampleIftaRates(Q, NOW, W)).toEqual({ ok: true, created: 48 });
    const rows = await listIftaRates(Q, W);
    expect(rows).toHaveLength(48);
    expect(rows.every((r) => r.isSample && r.sourceFile === "sample" && r.status === "provisional")).toBe(true);
    expect(await audits("ifta_rates_sample_loaded")).toHaveLength(2);
  });

  test("a real file replaces the sample quarter whole, rate and surcharge apart, exact decimals", async () => {
    // Another quarter and another desk, which the import must not touch.
    await prisma.iftaRate.create({ data: { workspaceId: W, quarter: "2026-Q2", jurisdiction: "TX", rate: "0.1999", status: "final", sourceFile: "q2.csv" } });
    await prisma.iftaRate.create({ data: { workspaceId: OTHER, quarter: Q, jurisdiction: "TX", rate: "0.3333", status: "final", sourceFile: "other.csv" } });

    const out = await commitIftaRates(FILE, null, Q, "final", "rates-q3.csv", NOW, W);
    if (!out.ok) throw new Error(out.error);
    expect(out).toMatchObject({ created: 4, replaced: 48, canada: 1, skipped: 1 });
    const rows = await listIftaRates(Q, W);
    expect(rows.map((r) => [r.jurisdiction, r.rate, r.surcharge, r.status, r.isSample, r.sourceFile])).toEqual([
      ["DC", "0.2350", "0.0000", "final", false, "rates-q3.csv"],
      ["IN", "0.5500", "0.1200", "final", false, "rates-q3.csv"],
      ["KY", "0.2460", "0.1020", "final", false, "rates-q3.csv"],
      ["TX", "0.2000", "0.0000", "final", false, "rates-q3.csv"]
    ]);
    const raw = await prisma.iftaRate.findFirstOrThrow({ where: { workspaceId: W, quarter: Q, jurisdiction: "KY" } });
    expect(raw.rate.toFixed(4)).toBe("0.2460");
    expect(raw.importBatchId).toBe(out.batchId);
    expect((await listIftaRates("2026-Q2", W)).map((r) => r.rate)).toEqual(["0.1999"]);
    expect((await listIftaRates(Q, OTHER)).map((r) => r.rate)).toEqual(["0.3333"]);

    const ev = await audits("ifta_rates_imported");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entityId: out.batchId });
    expect(ev[0]!.summary).toContain("4 rates for 2026-Q3 imported from rates-q3.csv");
    expect(ev[0]!.summary).toContain("replacing 48 rates (sample)");
    expect(ev[0]!.summary).toContain("1 Canadian row skipped");
    expect(ev[0]!.after).toMatchObject({ "Canadian rows skipped": "1", "Left out": "1", "With a surcharge": "2" });
  });

  test("sample rates never land over real ones", async () => {
    const s = await loadSampleIftaRates(Q, NOW, W);
    expect(s.ok).toBe(false);
    expect(await prisma.iftaRate.count({ where: { workspaceId: W, quarter: Q, isSample: true } })).toBe(0);
  });

  test("a second file replaces the first whole: a state it leaves out is gone, and a row status overrides the file's", async () => {
    const out = await commitIftaRates(["State,Rate,Status", "Texas,0.2100,", "Ohio,0.47,final"].join("\n"), null, Q, "provisional", "rates-q3-v2.csv", NOW, W);
    if (!out.ok) throw new Error(out.error);
    expect(out.replaced).toBe(4);
    const rows = await listIftaRates(Q, W);
    expect(rows.map((r) => [r.jurisdiction, r.rate, r.status])).toEqual([
      ["OH", "0.4700", "final"],
      ["TX", "0.2100", "provisional"]
    ]);
    const q = await iftaRateQuarters([Q, "2026-Q2", "2026-Q1", "bad"], W);
    expect(q).toEqual([
      { quarter: Q, count: 2, final: 1, sample: 0, sourceFile: "rates-q3-v2.csv", at: NOW },
      { quarter: "2026-Q2", count: 1, final: 1, sample: 0, sourceFile: "q2.csv", at: expect.any(Date) },
      { quarter: "2026-Q1", count: 0, final: 0, sample: 0, sourceFile: null, at: null }
    ]);
  });

  test("a file with no good US row changes nothing", async () => {
    const out = await commitIftaRates(["Jurisdiction,Rate", "Ontario,0.143", "Texas,"].join("\n"), null, Q, "final", "bad.csv", NOW, W);
    expect(out.ok).toBe(false);
    expect(await prisma.iftaRate.count({ where: { workspaceId: W, quarter: Q } })).toBe(2);
    const missing = await commitIftaRates("State,Gasoline\nTexas,0.2", null, Q, "final", "x.csv", NOW, W);
    expect(missing).toEqual({ ok: false, error: "Match a column to Rate first." });
  });

  test("two imports at once leave one whole table, not a mix", async () => {
    const a = ["Jurisdiction,Rate", "Texas,0.2001", "Ohio,0.4701"].join("\n");
    const b = ["Jurisdiction,Rate", "Texas,0.2002", "Iowa,0.3002"].join("\n");
    const [x, y] = await Promise.all([commitIftaRates(a, null, Q, "final", "a.csv", NOW, W), commitIftaRates(b, null, Q, "final", "b.csv", NOW, W)]);
    expect(x.ok && y.ok).toBe(true);
    const rows = await listIftaRates(Q, W);
    const files = new Set(rows.map((r) => r.sourceFile));
    expect(files.size).toBe(1);
    expect(rows).toHaveLength(2);
  });

  test("clear takes the quarter away, with one audit event, and refuses an empty quarter", async () => {
    const out = await clearIftaRates(Q, NOW, W);
    expect(out).toEqual({ ok: true, removed: 2 });
    expect(await prisma.iftaRate.count({ where: { workspaceId: W, quarter: Q } })).toBe(0);
    expect(await clearIftaRates(Q, NOW, W)).toEqual({ ok: false, error: "2026-Q3 has no rates to clear." });
    expect(await audits("ifta_rates_cleared")).toHaveLength(1);
    expect(await prisma.iftaRate.count({ where: { workspaceId: OTHER } })).toBe(1);
  });
});
