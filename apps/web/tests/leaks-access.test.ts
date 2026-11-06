import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { can } from "@/lib/roles";

/**
 * Who sees the Leak Ledger: the billing office (the `bill` capability: an admin, accounting, or a dispatcher an admin has allowed to bill). It prices mistakes and choices in dollars, so its screen, its files
 * and the headline on the KPI page all ask for that capability, and a viewer, a plain dispatcher and a driver manager get none of it.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the leak ledger is the billing office's", () => {
  test("the capability sorts the roles the way the decision says", () => {
    expect(can("admin", [], "bill")).toBe(true);
    expect(can("accounting", [], "bill")).toBe(true);
    expect(can("dispatcher", ["bill"], "bill")).toBe(true);
    expect(can("dispatcher", [], "bill")).toBe(false);
    expect(can("viewer", [], "bill")).toBe(false);
    expect(can("driver_manager", [], "bill")).toBe(false);
  });

  test("the page, the files and the KPI headline all ask for it", () => {
    expect(read("app/(desk)/leaks/page.tsx")).toMatch(/requirePage\("bill"\)/);
    expect(read("app/(desk)/export/[kind]/route.ts")).toMatch(/startsWith\("leaks"\)[^{]*\{\s+const noBill = await guardRoute\("bill"\)/);
    expect(read("app/(desk)/kpi/page.tsx")).toMatch(/checkAccess\("bill"\)/);
    expect(read("app/(desk)/kpi/page.tsx")).toMatch(/billAccess\.ok/);
  });

  test("the sidebar offers it to the roles that can bill", () => {
    expect(read("components/desk/desk-shell.tsx")).toMatch(/href: "\/leaks", label: "Leak ledger", code: "LK", roles: \["admin", "accounting"\]/);
  });

  test("the ledger reads no estimate: its server and pure code have no market rate or invented rate", () => {
    for (const f of ["lib/leaks.ts", "server/tl/leaks.ts"]) expect(read(f), f).not.toMatch(/marketBenchmark|benchmark|DEFAULT_RATE|assumedRate/i);
  });
});
