import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, can, type Capability } from "@/lib/roles";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

/**
 * A screen shows only the controls the signed-in role can use: the server still refuses everything (tests/loads-roles.test.ts), and these screens say so before a click instead of after.
 * Each entry is a screen and the component whose controls it switches off, with the capability the matching action needs.
 */
const GATED: Array<{ page: string; uses: string[]; caps: Capability[] }> = [
  { page: "src/app/(desk)/drivers/page.tsx", uses: ["<AddDriver", "<DriverRowActions", "<VetButton"], caps: ["dispatch"] },
  { page: "src/app/(desk)/drivers/[id]/page.tsx", uses: ["<DriverRowActions"], caps: ["dispatch"] },
  { page: "src/app/(desk)/drivers/[id]/page.tsx", uses: ["<DriverCodeEdit"], caps: ["roster"] },
  { page: "src/app/(desk)/drivers/import/page.tsx", uses: ["<ImportPanel"], caps: ["dispatch"] },
  { page: "src/app/(desk)/loads/import/page.tsx", uses: ["<LoadImportPanel"], caps: ["dispatch"] },
  { page: "src/app/(desk)/loads/import/weekly/page.tsx", uses: ["<TrackerImportPanel"], caps: ["dispatch"] },
  { page: "src/app/(desk)/fleet/page.tsx", uses: ["<AddTruck", "<TruckRowActions", "<SyncEldButton"], caps: ["dispatch"] },
  { page: "src/app/(desk)/fleet/[id]/page.tsx", uses: ["<TruckRowActions", "<TruckForm", "<CostProfileForm", "<FuelCardForm"], caps: ["dispatch"] },
  { page: "src/app/(desk)/fleet/import/page.tsx", uses: ["<ImportPanel"], caps: ["dispatch"] },
  { page: "src/app/(desk)/trailers/page.tsx", uses: ["<AddTrailer", "<TrailerRowActions"], caps: ["dispatch"] },
  { page: "src/app/(desk)/trailers/page.tsx", uses: ["<DwellAdjust"], caps: ["dispatch", "bill"] },
  { page: "src/app/(desk)/trailers/[id]/page.tsx", uses: ["<DwellAdjust"], caps: ["dispatch", "bill"] },
  { page: "src/app/(desk)/fleet/map/page.tsx", uses: ["<SyncEldButton"], caps: ["dispatch"] },
  { page: "src/app/(desk)/trailers/[id]/page.tsx", uses: ["<TrailerRowActions", "<HookTrailer", "<TrailerForm"], caps: ["dispatch"] },
  { page: "src/app/(desk)/trailers/import/page.tsx", uses: ["<ImportPanel"], caps: ["dispatch"] },
  { page: "src/app/(desk)/rate-cons/page.tsx", uses: ["<RateConIntake"], caps: ["dispatch"] },
  { page: "src/app/(desk)/messages/page.tsx", uses: ["<Composer"], caps: ["dispatch", "bill"] },
  { page: "src/app/(desk)/customers/[id]/page.tsx", uses: ["<CustomerForm"], caps: ["dispatch", "billing_details"] },
  { page: "src/app/(desk)/loads/page.tsx", uses: ["<RestoreLoadButton"], caps: ["dispatch"] },
  { page: "src/app/(desk)/signals/page.tsx", uses: ["<AcknowledgeSignalButton"], caps: ["dispatch"] }
];

describe("screens switch off the controls a role cannot use", () => {
  for (const g of GATED) {
    it(`${g.page}: every ${g.uses.join(", ")} sits inside a gate for ${g.caps.join(" or ")}`, () => {
      const text = src(g.page);
      expect(text).toContain('from "@/components/desk/kit/can-gate"');
      for (const use of g.uses) {
        const at = text.indexOf(use);
        expect(at, `${use} is on the page`).toBeGreaterThan(-1);
        // The nearest gate opening before the control names the capabilities, and no gate closes between them.
        const before = text.slice(0, at);
        const open = before.lastIndexOf("<CanGate caps={[");
        expect(open, `${use} has a gate before it`).toBeGreaterThan(-1);
        expect(before.slice(open)).not.toContain("</CanGate>");
        const named = /<CanGate caps=\{\[([^\]]*)\]\}/.exec(before.slice(open))![1]!.replace(/["\s]/g, "").split(",");
        expect(named.sort()).toEqual([...g.caps].sort());
      }
    });
  }

  it("the gate is the same rule as the server's: someone the server would refuse is switched off", () => {
    // The viewer and the billing office cannot dispatch; a dispatcher and an admin can.
    expect(ROLES.filter((r) => can(r, [], "dispatch"))).toEqual(["dispatcher", "admin"]);
    // A shared screen opens to either office.
    expect(ROLES.filter((r) => can(r, [], "dispatch") || can(r, [], "bill"))).toEqual(["dispatcher", "accounting", "admin"]);
  });

  it("the gate asks the member table once per request, however many controls it wraps", () => {
    const gate = src("src/components/desk/kit/can-gate.tsx");
    expect(gate).toContain("cache(");
    expect(gate).toContain("checkAccess(");
  });

  it("the Dispatch queue's driver buttons only show to someone who may dispatch", () => {
    const page = src("src/app/(desk)/dispatch/page.tsx");
    expect(page).toContain('checkAccess("dispatch")');
    expect(page).not.toMatch(/<Row[^>]* assign \/>/);
  });
});
