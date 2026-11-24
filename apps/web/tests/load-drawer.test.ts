import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The drawer is the only view of a load (Chris, 2026-11-23: the full load page is gone). Everything the page could do is in the drawer: these read the source for each thing that had no other home, so a
 * tidy-up cannot quietly take the way to deliver a load, change it, or put a mistake right.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8").replace(/\r\n/g, "\n");
const view = read("components/desk/load-view.tsx");
const between = (a: string, b: string) => {
  const i = view.indexOf(a);
  expect(i, a).toBeGreaterThan(-1);
  return view.slice(i, view.indexOf(b, i));
};
const trip = between("const drawerTrip", "const drawerMoney");
const money = between("const drawerMoney", "const drawerPaper");
const paper = between("const drawerPaper", "const drawerMore");
const more = between("const drawerMore", "const drawerDeck");

describe("a load has one view", () => {
  test("its address is the Loads board with the drawer over it, and nothing draws a load page", () => {
    const page = read("app/(desk)/loads/[id]/page.tsx");
    expect(page).toContain("<LoadsPage />");
    expect(page).toContain("notFound()");
    expect(page).not.toContain("LoadView");
    expect(existsSync(join(SRC, "app/(desk)/@drawer/loads/[id]/page.tsx"))).toBe(true);
    for (const f of ["components/desk/load-view.tsx", "components/desk/load-cockpit.tsx", "components/desk/drawer-frame.tsx"]) {
      expect(read(f)).not.toMatch(/Open full page|Edit on the full page|Full breakdown|variant === "page"/);
    }
  });
});

describe("what only the page could do is in the drawer", () => {
  test("Trip: edit the load, enter the pickup, the delivery and the costs, the driver, the trailer, the relay, detention, and TONU, cancel and delete", () => {
    // Edit is in the drawer's head, so it is one press away on every tab.
    expect(view.slice(view.indexOf("<LoadCockpit"))).toMatch(/actions=\{fellThrough \|\| !may\("dispatch"\) \? null : <LoadEditDialog/);
    for (const part of ["tripSec", "driverSec", "trailerSec", "relaySec", "docksSec", "moreSec"]) expect(trip, part).toContain(part);
    expect(view).toContain("<TripEntry");
    expect(view).toContain("<WaiveDetentionButton");
    // While it is the work it is in view; once the load is delivered it is one line.
    expect(trip).toMatch(/open \? gate\(tripSec, "dispatch", "figures"\) : <Fold title="Trip record"/);
  });
  test("Money: the billing details, the mile analysis, the booking decision, and taking something back", () => {
    for (const part of ["<BillingDetailsDialog", "countSec", "decisionSec", "correctionsSec"]) expect(money, part).toContain(part);
    const fix = between("const correctionsSec", "const chips");
    for (const action of ["undoStartAction", "reopenCancelledAction", "reopenDeliveredAction", "voidInvoiceAction", "undoPaidAction"]) expect(fix, action).toContain(action);
    expect(fix).toMatch(/"dispatch"/);
    expect(fix).toMatch(/"bill"/);
  });
  test("Paperwork: the list and upload, the inspector, the invoice", () => {
    for (const part of ["<LoadDocuments", "<SplitDocViewer", "invoiceSec"]) expect(paper, part).toContain(part);
  });
  test("More: progress, the trail, who held it, what the driver sees, the tracking link, the partners", () => {
    for (const part of ["whereSec", "activitySec", "holderSec", "cabSheet", "trackingSec", "shelfSec"]) expect(more, part).toContain(part);
  });
});
