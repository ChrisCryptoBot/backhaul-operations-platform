import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Who sees Data health and the readiness report: the billing office (the `bill` capability), like the Leak ledger, because it reads money (invoices against rate confirmations, fuel against cards). The screen, the
 * report and the files all ask for it, the sidebar offers it to the roles that can bill, the print sheet follows the same `.rp` rules as the KPI report, and the engine estimates nothing.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8").split(String.fromCharCode(13)).join("");

describe("data health is the billing office's", () => {
  test("the page, the report and the files all ask for the capability", () => {
    expect(read("app/(desk)/data-health/page.tsx")).toMatch(/requirePage\("bill"\)/);
    expect(read("app/(desk)/data-health/report/page.tsx")).toMatch(/requirePage\("bill"\)/);
    expect(read("app/(desk)/export/[kind]/route.ts")).toMatch(/startsWith\("data-health"\)/);
  });

  test("the sidebar offers it to the roles that can bill", () => {
    expect(read("components/desk/desk-shell.tsx")).toMatch(/href: "\/data-health", label: "Data health", code: "DH", roles: \["admin", "accounting"\]/);
  });

  test("the report is a printed sheet in the same style as the management report", () => {
    const sheet = read("app/(desk)/data-health/report/page.tsx");
    expect(sheet).toContain('<article className="rp">');
    expect(sheet).toContain("<DocHead");
    expect(sheet).toContain("<PrintButton");
    expect(sheet).toContain('className="no-print"');
    expect(sheet).toContain("rp-foot");
    expect(sheet).toContain("rp-meta");
    // Sheets keep the global print rules: it adds no colour or layout of its own.
    expect(sheet).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(sheet).not.toMatch(/style=\{\{[^}]*(background|border|color)/);
  });

  test("the engine estimates nothing: no assumed or default rate fills a missing field (it only asks whether the field is there)", () => {
    for (const f of ["lib/data-health.ts", "server/tl/data-health.ts"]) expect(read(f), f).not.toMatch(/DEFAULT_RATE|assumedRate|defaultMarket|assumed/i);
  });

  test("the export kinds are listed, so a file is never offered that the route would refuse", () => {
    expect(read("server/tl/exports.ts")).toMatch(/"data-health", "data-health-checks"/);
  });
});
