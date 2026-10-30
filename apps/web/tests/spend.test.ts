import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { MAX_RATE_CON_PAGES, pdfPageCount } from "../src/lib/pdf-pages";
import { RATE_CON_READS_BY_PLAN, rateConReadsPerDay } from "../src/lib/plans";
import { SPEND, decideClaim, refusalText, switchedOff, windowStarts, type Counts } from "../src/lib/spend";
import { BUDGETS } from "../src/server/tl/budget";

const zero: Counts = { workspaceDay: 0, workspaceMonth: 0, globalDay: 0, globalMonth: 0, globalMonthCents: 0 };

describe("the ceilings (spend-guardrails plan)", () => {
  it("Mapbox is capped in code because Mapbox cannot cap it: 60,000 of each a month for everyone, 60% of the free tier", () => {
    expect(SPEND.mapbox_geocode.limits.globalMonth).toBe(60_000);
    expect(SPEND.mapbox_directions.limits.globalMonth).toBe(60_000);
    expect(SPEND.mapbox_geocode.limits.workspaceDay! + SPEND.mapbox_directions.limits.workspaceDay!).toBe(1_500); // one desk's calls a day
  });
  it("permanent geocoding (no free tier) is the tightest: 150 a day a desk, 3,000 a month in all", () => {
    expect(SPEND.mapbox_permanent.limits).toEqual({ workspaceDay: 150, globalMonth: 3_000 });
    expect(SPEND.mapbox_permanent.estCents).toBeGreaterThan(0);
  });
  it("desk reads: a global 60 a day and 25 dollars a month; the per-desk number comes from the plan", () => {
    expect(SPEND.anthropic_desk.limits).toEqual({ globalDay: 60, globalMonthCents: 2_500 });
    expect(RATE_CON_READS_BY_PLAN).toEqual({ starter: 10, growth: 25, pro: 50, enterprise: 100 });
    expect(rateConReadsPerDay(null)).toBe(10); // no plan chosen is Starter
    expect(rateConReadsPerDay("nonsense")).toBe(10);
    expect(rateConReadsPerDay("pro")).toBe(50);
  });
  it("the per-instance route budgets were cut: a measure is up to a hundred calls, so 300 a day allowed about 30,000 calls", () => {
    expect(BUDGETS.geo_measure).toBe(60);
    expect(BUDGETS.geo_suggest).toBe(600);
  });
});

describe("decideClaim", () => {
  it("allows a claim under every limit and refuses the first window that would be passed, narrowest first", () => {
    const limits = { workspaceDay: 3, workspaceMonth: 10, globalDay: 5, globalMonth: 20, globalMonthCents: 100 };
    expect(decideClaim(zero, limits, 1, 8)).toEqual({ ok: true });
    expect(decideClaim({ ...zero, workspaceDay: 3 }, limits, 1, 8)).toEqual({ ok: false, reason: "workspace_day" });
    expect(decideClaim({ ...zero, workspaceMonth: 10 }, limits, 1, 8)).toEqual({ ok: false, reason: "workspace_month" });
    expect(decideClaim({ ...zero, globalDay: 5 }, limits, 1, 8)).toEqual({ ok: false, reason: "global_day" });
    expect(decideClaim({ ...zero, globalMonth: 20 }, limits, 1, 8)).toEqual({ ok: false, reason: "global_month" });
    expect(decideClaim({ ...zero, globalMonthCents: 95 }, limits, 1, 8)).toEqual({ ok: false, reason: "global_month_cents" });
    // a desk at its own limit is told its own limit, not "busy"
    expect(decideClaim({ ...zero, workspaceDay: 3, globalDay: 5 }, limits, 1, 8)).toEqual({ ok: false, reason: "workspace_day" });
  });
  it("counts the units claimed, not just the claim: a batch that does not fit is refused whole", () => {
    expect(decideClaim({ ...zero, workspaceDay: 8 }, { workspaceDay: 10 }, 2, 0)).toEqual({ ok: true });
    expect(decideClaim({ ...zero, workspaceDay: 8 }, { workspaceDay: 10 }, 3, 0)).toEqual({ ok: false, reason: "workspace_day" });
  });
  it("a limit that is not set is not a limit", () => {
    expect(decideClaim({ workspaceDay: 1e6, workspaceMonth: 1e6, globalDay: 1e6, globalMonth: 1e6, globalMonthCents: 1e6 }, {}, 1, 8)).toEqual({ ok: true });
  });
  it("the refusal words say whose limit it was", () => {
    expect(refusalText("workspace_day")).toMatch(/tomorrow/);
    expect(refusalText("global_day")).toMatch(/busy/);
  });
});

describe("the kill switch and the windows", () => {
  it("DESK_SERVICES_OFF names the services to switch off, or all of them", () => {
    expect(switchedOff("mapbox_geocode", undefined)).toBe(false);
    expect(switchedOff("mapbox_geocode", "")).toBe(false);
    expect(switchedOff("mapbox_geocode", "mapbox_geocode")).toBe(true);
    expect(switchedOff("anthropic_desk", " mapbox_geocode , ANTHROPIC_DESK ")).toBe(true);
    expect(switchedOff("mapbox_directions", "mapbox_geocode")).toBe(false);
    expect(switchedOff("mapbox_permanent", "all")).toBe(true);
  });
  it("a day and a month are UTC calendar windows", () => {
    const w = windowStarts(new Date("2026-10-31T23:59:59Z"));
    expect(w.day.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(w.month.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(windowStarts(new Date("2026-11-01T00:00:00Z")).month.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

const bytes = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));
const pdfWith = (pages: number, tree = true) =>
  bytes(
    "%PDF-1.4\n" +
      (tree ? `1 0 obj\n<< /Type /Pages /Count ${pages} /Kids [] >>\nendobj\n` : "") +
      Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj\n<< /Type /Page /Parent 1 0 R >>\nendobj\n`).join("") +
      "%%EOF"
  );

describe("pdfPageCount (the same cases as the phone backend's)", () => {
  it("counts page objects and the page tree total, not the /Pages node", () => {
    expect(pdfPageCount(pdfWith(3))).toBe(3);
    expect(pdfPageCount(pdfWith(MAX_RATE_CON_PAGES))).toBe(12);
    expect(pdfPageCount(pdfWith(13))).toBe(13);
    expect(pdfPageCount(pdfWith(40, false))).toBe(40);
    expect(pdfPageCount(bytes("%PDF-1.5\n<< /Type /Pages /Count 57 >>"))).toBe(57);
    expect(pdfPageCount(bytes("<</Type/Page>><</Type /Page>><</Type\n/Page>><</Type/Pages>>"))).toBe(3);
  });
  it("answers 0 (unknown) for a file with no page tree, never a false 'too many'", () => {
    expect(pdfPageCount(bytes("%PDF-1.7\n" + "x".repeat(5000)))).toBe(0);
    expect(pdfPageCount(new Uint8Array(0))).toBe(0);
  });
  it("is one byte pass", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 2) big[i] = 0x2f;
    const t = Date.now();
    pdfPageCount(big);
    expect(Date.now() - t).toBeLessThan(2_000);
  });
});

describe("every paid call goes through the ledger (static guard)", () => {
  const SRC = path.join(__dirname, "..", "src");
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const files = walk(SRC);

  it("api.mapbox.com is named in exactly one file, and every call in it passes the service it is claimed against", () => {
    const hits = files.filter((f) => fs.readFileSync(f, "utf8").includes("api.mapbox.com")).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(hits).toEqual(["server/geo/mapbox.ts"]);
    const m = read("server/geo/mapbox.ts");
    expect(m).toContain("claimUsage(service)");
    const calls = (m.match(/getJson\(/g) ?? []).length - 1; // minus the definition
    const claimed = (m.match(/"mapbox_(geocode|directions|permanent)"\)/g) ?? []).length;
    expect(calls).toBe(4);
    expect(claimed).toBe(calls);
  });

  it("the Anthropic client is made in one file, and the action claims the read before it calls it", () => {
    const hits = files.filter((f) => /new Anthropic\(/.test(fs.readFileSync(f, "utf8")) && !f.includes(`${path.sep}truelane${path.sep}`)).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(hits).toEqual(["server/ratecon/reader.ts"]);
    const reader = read("server/ratecon/reader.ts");
    expect(reader).toContain("timeout: READ_TIMEOUT_MS");
    expect(reader).toContain("max_tokens: MAX_OUTPUT_TOKENS");
    const actions = read("app/(desk)/actions.ts");
    const claim = actions.indexOf("await claimRead()");
    const call = actions.indexOf("await readRateCon({ fileName: file.name, mime");
    expect(claim).toBeGreaterThan(0);
    expect(claim).toBeLessThan(call);
    expect(actions.indexOf("pdfPageCount(checked.data)")).toBeLessThan(claim);
  });
});
