import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signedPct } from "@/lib/desk-format";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8").replace(/\r\n/g, "\n");
const page = (p: string) => read(`app/(desk)/${p}/page.tsx`);
const order = (s: string, marks: string[]) => marks.map((m) => s.lastIndexOf(m));

/** The market and money screens' own rules, read from the source: what comes first, one main button, one control for one thing, and reasons that can be read. No figure is pinned here. */
describe("what is owed comes first on Invoices", () => {
  const s = page("invoices");
  it("goes what is out, what to invoice, detention left off, then paid", () => {
    const at = order(s, ["Out and waiting ·", "Ready to invoice ·", "Detention not yet billed, last 90 days", "Paid ·"]);
    expect(at.every((x) => x > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
  it("opens with the five largest detentions, the rest one press away and the total still for all of them", () => {
    expect(s).toContain("const DETENTION_FIRST = 5;");
    expect(s).toContain("href({ detention: true })");
    expect(s).toContain("usd(detention.totalUnbilled, 2)");
  });
  it("keeps the five aging buckets, over the list they describe", () => {
    const out = s.slice(s.lastIndexOf("Out and waiting ·"), s.lastIndexOf("Ready to invoice ·"));
    for (const k of ["current", "d1_30", "d31_60", "d61_90", "d90plus"]) expect(out).toContain(`aging.buckets.${k}`);
  });
  it("has no gold button in a row: the dialog has the one", () => {
    const s2 = read("components/desk/load-actions.tsx");
    expect(s2.slice(s2.indexOf("export function InvoiceDialog"))).not.toContain("sm primary");
  });
});

describe("a button that cannot be pressed says why without breaking the page", () => {
  it("Payroll's toolbar is one line, and a statement's reason is never cut to one", () => {
    expect(read("components/desk/partner-actions.tsx")).toContain('className="t-bar"');
    expect(page("payroll").match(/t-st say wrap/g)!.length).toBe(2);
    expect(read("app/terminal.css")).toMatch(/\.t-st\.say\.wrap\{white-space:normal/);
  });
  it("Fuel says it under the head, so the head keeps one height", () => {
    expect(page("fuel")).toContain('{cardReason ? <p className="tl-note t-lede">{cardReason}</p> : null}');
  });
});

describe("IFTA: marking a return filed sits with what stands in its way", () => {
  it("in one card, blockers first, and the server still decides", () => {
    const s = page("ifta");
    const card = s.slice(s.indexOf('title="File this return"'), s.indexOf("<IftaFileButton") + 40);
    expect(card).toContain("ifta-blocklist");
    expect(card.indexOf("ifta-blocklist")).toBeLessThan(card.indexOf("<IftaFileButton"));
    expect(s).toContain("blocked={fileBlocked}");
    // A filed return is not "past due", and what changed since leads with the return; its jurisdictions are one press away.
    expect(s).toContain("tone={filed ? undefined :");
    expect(s).toContain('<Fold title="By jurisdiction"');
    // A filed return that has since become open still says so.
    expect(s).toContain("{filed && r.blockers.length > 0 ? (");
  });
});

describe("one control for one thing", () => {
  it("Compare is a switch on the KPI and Leak pages, not a second chosen tab", () => {
    for (const p of ["kpi", "leaks"]) {
      expect(page(p)).toContain("<CompareSwitch on={params.compare} href={href({ compare: !params.compare })} />");
      expect(page(p)).not.toMatch(/className="tl-tab" aria-current=\{params\.compare/);
    }
    expect(read("components/desk/kpi/parts.tsx")).toContain('role="switch" aria-checked={on}');
  });
  it("Why it moved has one lane or customer switch, for both lists", () => {
    expect(page("kpi/moved").match(/By customer/g)).toHaveLength(1);
    for (const p of ["moves", "cash"]) expect(read(`components/desk/moves/${p}.tsx`)).not.toContain("hrefFor");
  });
});

describe("KPI: the hero first, and no holes between charts", () => {
  const s = page("kpi");
  it("gross revenue comes before the cash beside it", () => {
    const body = s.slice(s.indexOf('<div className="kstack">'));
    expect(body.indexOf("<KpiMatrix")).toBeGreaterThan(0);
    expect(body.indexOf("<KpiMatrix")).toBeLessThan(body.indexOf("<CashCard"));
  });
  it("keeps every chart, in two columns that close up on their own", () => {
    for (const c of ["SmallMultiples", "GrowthColumns", "DriverLeaderboard", "Bullets", "VarianceHistogram", "DeadheadBars", "ReasonsCard", "MonthlyBars", "ServiceCard", "FuelSurchargeCard", "TenderCard", "TruckEmptyCard", "MixCard"]) expect(s.match(new RegExp(`<${c} `, "g")), c).toHaveLength(1);
    expect(s).toContain("k-cols");
  });
});

describe("what a screen says", () => {
  it("every leak's basis is on the page in full, without the files' field names", () => {
    const s = read("components/desk/leaks/ledger.tsx");
    expect(s).toContain("How each line is worked out");
    expect(s.match(/plain\(l\.basis\)/g)).toHaveLength(3);
  });
  it("a grade has its own tone: mostly there is amber, not red", () => {
    expect(read("components/desk/data-health/parts.tsx")).toContain("`tl-chip ${g.tone}`");
  });
  it("a change in percent uses the minus sign the figures use", () => {
    expect([signedPct(0.0941), signedPct(-0.047), signedPct(0), signedPct(null)]).toEqual(["+9.4%", "−4.7%", "0.0%", "—"]);
  });
  it("a lane with no target says so once, quietly, and never counts none of none", () => {
    const s = read("components/desk/kpi/lanes.tsx");
    expect(s).toContain("No lane has a target yet. ");
    expect(s).not.toContain("NO TARGET");
  });
});
