import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shelfFor, shelfHeader, type ShelfInput } from "@/lib/partner-shelf";

const base: ShelfInput = { connected: {}, factoringStatus: "none", docKinds: [], driverName: null, hosHours: null, hosSyncedAt: null, vetStatus: null, coiExpiresAt: null, onStatement: false, totalMiles: 612 };
const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

describe("the partner shelf says only what is true", () => {
  it("with nothing connected, no card says connected, synced, verified, active or ready, and the header counts none", () => {
    const cards = shelfFor({ ...base, driverName: "Sam Okafor" });
    expect(shelfHeader({})).toBe("0 of 7 partner connections made");
    for (const c of cards) expect(c.chip, c.key).not.toMatch(/^(CONNECTED|SYNCED|VERIFIED|ACTIVE|AUDIT READY|HOURS OK)$/);
    for (const k of ["eld", "fuel_card", "tracking"]) expect(cards.find((c) => c.key === k)!.chip).toBe("NOT CONNECTED");
  });

  it("every connectable vertical says what the dispatcher does by hand while it is not connected, and nothing once it is", () => {
    const off = shelfFor(base);
    for (const k of ["factoring", "eld", "fuel_card", "tracking", "payroll", "vetting"]) expect(off.find((c) => c.key === k)!.byHand, k).toMatch(/^Not connected/);
    const on = shelfFor({ ...base, connected: { factoring: true, eld: true, fuel_card: true, tracking: true, payroll: true, vetting: true } });
    for (const k of ["factoring", "eld", "fuel_card", "tracking", "payroll", "vetting"]) expect(on.find((c) => c.key === k)!.byHand, k).toBeNull();
    expect(shelfHeader({ factoring: true, eld: true })).toBe("2 of 7 partner connections made");
  });

  it("factoring names the documents that are really missing, not a count of any two", () => {
    expect(shelfFor({ ...base, docKinds: ["receipt", "other"] }).find((c) => c.key === "factoring")!.line).toBe("Missing: rate confirmation and proof of delivery.");
    expect(shelfFor({ ...base, docKinds: ["rate_con"] }).find((c) => c.key === "factoring")!.line).toBe("Missing: proof of delivery.");
    expect(shelfFor({ ...base, docKinds: ["rate_con", "pod"] }).find((c) => c.key === "factoring")!.line).toBe("Rate confirmation and proof of delivery are on file.");
  });

  it("hours, vetting and payroll show only what the desk holds: a figure that is not known is not drawn", () => {
    expect(shelfFor({ ...base, connected: { eld: true }, driverName: "Sam" }).find((c) => c.key === "eld")!.line).toBe("Hours left are not known.");
    expect(shelfFor({ ...base, connected: { eld: true }, driverName: "Sam", hosHours: 4.5, hosSyncedAt: "Nov 4, 9:02 AM CT" }).find((c) => c.key === "eld")!.line).toBe("Sam: 4.5 h left, as of Nov 4, 9:02 AM CT.");
    expect(shelfFor({ ...base, driverName: "Sam" }).find((c) => c.key === "vetting")!.chip).toBe("NOT CHECKED");
    expect(shelfFor({ ...base, driverName: "Sam", vetStatus: "clear" }).find((c) => c.key === "vetting")!.tone).toBe("ok");
    expect(shelfFor({ ...base }).find((c) => c.key === "payroll")!.chip).toBe("NO DRIVER");
    expect(shelfFor({ ...base, driverName: "Sam", onStatement: true }).find((c) => c.key === "payroll")!.chip).toBe("ON A STATEMENT");
  });

  it("fuel tax and insurance say they are not built yet", () => {
    const cards = shelfFor(base);
    expect(cards.find((c) => c.key === "ifta")!.chip).toBe("NOT BUILT YET");
    expect(cards.find((c) => c.key === "ifta")!.line).toContain("612 mi on this load");
    expect(cards.find((c) => c.key === "insurance")!.chip).toBe("NOT BUILT YET");
  });

  it("the load page carries none of the invented figures it once showed, and draws the shelf from the presenter", () => {
    const view = src("src/components/desk/load-view.tsx");
    for (const lie of ["8 of 8", "4h 22m", "$1M Auto Liability", "Customer share link ready", "FMCSA active", "state tax journals", "Packet ready (Rate Con + POD verified)"]) expect(view, lie).not.toContain(lie);
    expect(view).toContain("shelfFor(");
    expect(view).toContain("partnerStatus()");
  });
});

describe("the sample-data notice belongs to the demo desk alone", () => {
  it("the shell and the report print it only when the demo door is on, and the page description does not say it", () => {
    expect(src("src/components/desk/desk-shell.tsx")).toMatch(/demoLogin \? "SAMPLE DATA ONLY/);
    expect(src("src/app/(desk)/kpi/report/page.tsx")).toMatch(/demoLoginOn\(process\.env\) \? <p className="rp-foot">Sample data only/);
    expect(src("src/app/layout.tsx")).not.toContain("sample data");
  });
});

describe("a fleet's cached answers do not read another fleet's rows", () => {
  it("dataMark scopes stops, assignments and cost profiles to the workspace", () => {
    const cache = src("src/server/tl/answer-cache.ts");
    expect(cache).not.toMatch(/from stops\)/);
    expect(cache).not.toMatch(/from assignments\)/);
    expect(cache).not.toMatch(/from cost_profiles\)/);
    expect(cache).toContain("join loads l on l.id = s.load_id where l.workspace_id");
    expect(cache).toContain("join vehicles v on v.id = c.vehicle_id where v.workspace_id");
  });
});
