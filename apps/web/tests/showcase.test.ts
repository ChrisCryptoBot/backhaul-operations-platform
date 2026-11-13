import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { SHOWCASE_STEPS, SHOWCASE_WORKSPACE_ID, SIMULATOR_LABEL, STEP_INFO, isShowcaseStep } from "@/lib/showcase";

/** Money plan Wave 7 step 5, pure and by source: the walkthrough's order, its labels, and the gates (admin, simulator allowed, its own fleet, its own receiver). */
const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

describe("the partner showcase", () => {
  test("one load's life, in order: ELD, vetting, tracking, fuel, IFTA, factoring, payroll, QuickBooks, then the webhook out and the read API in", () => {
    expect(SHOWCASE_STEPS).toEqual(["eld", "vetting", "tracking", "fuel", "ifta", "factoring", "payroll", "quickbooks", "webhook", "read_api"]);
    for (const s of SHOWCASE_STEPS) expect(STEP_INFO[s].title.length, s).toBeGreaterThan(3);
    expect(isShowcaseStep("factoring")).toBe(true);
    expect(isShowcaseStep("delete_everything")).toBe(false);
    expect(SIMULATOR_LABEL).toBe("Simulator, not the company");
    expect(SHOWCASE_WORKSPACE_ID).not.toBe("demo-workspace");
  });

  test("the simulators are named for what they are modeled on, never as the company", () => {
    for (const s of SHOWCASE_STEPS.slice(0, 8)) expect(STEP_INFO[s].modeledOn, s).toMatch(/simulator \(modeled on /i);
  });

  test("gates: the page asks for an admin and the simulator; every server entry refuses on a live desk; every step runs inside explicitTenancy", () => {
    const page = src("app/(desk)/partners/showcase/page.tsx");
    expect(page.indexOf('requirePage("admin")')).toBeGreaterThan(-1);
    expect(page.indexOf("showcaseAllowed()")).toBeLessThan(page.indexOf("showcaseSnapshot()"));
    const server = src("server/partners/showcase.ts");
    for (const fn of ["export async function resetShowcase", "export async function runShowcaseStep"]) {
      const body = server.slice(server.indexOf(fn), server.indexOf(fn) + 400);
      expect(body, fn).toContain("if (!showcaseAllowed()) return refused();");
    }
    expect(server).toMatch(/explicitTenancy\(W, async \(\) => \{\r?\n\s+if \(step === "read_api"\)/);
    expect(server).not.toMatch(/currentWorkspaceId/);
    // every company key it saves is a simulator key
    expect(server).toContain("`sandbox_showcase_${name.toLowerCase()}`");
    const actions = src("app/(desk)/actions.ts");
    for (const a of ["resetShowcaseAction", "runShowcaseStepAction"]) expect(actions).toMatch(new RegExp(`export async function ${a}\\([^)]*\\)[^{]*\\{\\r?\\n  await requireCan\\("admin"\\);`));
  });

  test("the outbound webhook goes to the receiver built into the desk, and the schedule never takes the showcase's rows", () => {
    const server = src("server/partners/showcase.ts");
    expect(server).toContain("transport: builtInReceiver");
    expect(server).not.toMatch(/pinnedTransport|systemResolver/);
    const deliver = src("server/webhooks/deliver.ts");
    expect(deliver).toContain('AND x."workspace_id" <> ${SHOWCASE_WORKSPACE_ID}');
  });
});
