import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLES, can, canAny, type Capability, type Role } from "../src/lib/roles";

/**
 * Who may do what on the desk, action by action. auth-guard.test.ts proves every action asks the member table; roles.test.ts proves what each role may do; this pins which capability each
 * action asks for, then runs the table against the four roles so a person in each office can be told exactly what they may press. A new action that is not in this table fails here until
 * somebody decides which office it belongs to.
 */
const ACTIONS = path.join(__dirname, "..", "src", "app", "(desk)", "actions.ts");
const text = readFileSync(ACTIONS, "utf8").replace(/\r\n/g, "\n");
const needsOf = (name: string): Capability[] | null => {
  const at = text.indexOf(`export async function ${name}(`);
  if (at < 0) return null;
  const m = text.slice(at, at + 600).match(/requireCan\(((?:"\w+"(?:, )?)+)\)/);
  return m ? (m[1]!.split(", ").map((c) => c.replace(/"/g, "")) as Capability[]) : null;
};

/** The capability (or either of two) each action needs. */
const TABLE: Record<string, Capability[]> = {
  // reading and pricing
  assignOptionsAction: ["read"], readSampleRateConAction: ["read"], setAppearanceAction: ["read"], priceQuoteAction: ["read"], listQuotesAction: ["read"], previewImportAction: ["read"],
  // negotiating
  saveQuoteAction: ["quote"], bookQuoteAction: ["quote"], passQuoteAction: ["quote"], discardQuoteAction: ["quote"],
  // running loads and the fleet
  assignAction: ["dispatch"], assignFromQueueAction: ["dispatch"], unassignAction: ["dispatch"], sendAction: ["dispatch"], respondAction: ["dispatch"], retryBridgeAction: ["dispatch"], saveTimezoneAction: ["admin"], savePartnerKeysAction: ["admin"], removePartnerKeysAction: ["admin"], retryPartnerAction: ["admin"], sendTestEventAction: ["admin"], shareLocationAction: ["dispatch"], syncFuelCardsAction: ["dispatch", "bill"], calculateIftaAction: ["bill"], cancelAction: ["dispatch"], tonuAction: ["dispatch"],
  rescheduleAction: ["dispatch"], readUploadedRateConAction: ["dispatch"], saveRateConAction: ["dispatch"], saveLoadDetailsAction: ["dispatch"], deleteLoadAction: ["dispatch"], restoreLoadAction: ["dispatch"],
  startTripAction: ["dispatch"], undoStartAction: ["dispatch"], reopenDeliveredAction: ["dispatch"], reopenCancelledAction: ["dispatch"], completeTripAction: ["dispatch"],
  saveDriverAction: ["dispatch"], setDriverActiveAction: ["dispatch"], saveTruckAction: ["dispatch"], setTruckArchivedAction: ["dispatch"], saveTrailerAction: ["dispatch"], setTrailerArchivedAction: ["dispatch"],
  hookTrailerAction: ["dispatch"], assignTrailerAction: ["dispatch"], logCheckCallAction: ["dispatch"], removeCheckCallAction: ["dispatch"], saveCostProfileAction: ["dispatch"], commitImportAction: ["dispatch"], locateHomeBasesAction: ["dispatch"], previewLoadImportAction: ["dispatch"], commitLoadImportAction: ["dispatch"], removeLoadImportAction: ["dispatch"], previewHistoryImportAction: ["dispatch"], commitHistoryImportAction: ["dispatch"], removeHistoryImportAction: ["dispatch"],
  syncEldAction: ["dispatch"], saveFuelCardAction: ["dispatch"], vetCarrierAction: ["dispatch"],
  // shared between the offices
  saveBillingDetailsAction: ["billing_details"], saveCustomerAction: ["dispatch", "billing_details"], sendMessageAction: ["dispatch", "bill"], markThreadReadAction: ["dispatch", "bill"],
  correctTripAction: ["figures"], saveExpensesAction: ["figures"], importFuelAction: ["figures"], removeDocumentAction: ["documents"],
  // billing and payroll
  invoiceLoadAction: ["bill"], paidAction: ["bill"], voidInvoiceAction: ["bill"], undoPaidAction: ["bill"], chasedAction: ["bill"], waiveDetentionAction: ["bill"], factorInvoiceAction: ["bill"], factoringUpdateAction: ["bill"],
  startSettlementAction: ["bill"], saveSettlementAction: ["bill"], finalizeSettlementAction: ["bill"], discardSettlementAction: ["bill"], sendToPayrollAction: ["payout"], markSettlementPaidAction: ["payout"],
  // money that is gone
  voidSettlementAction: ["writeoff"],
  // the company, the rules, the connections and the team
  saveThresholdsAction: ["admin"], saveCompanyAction: ["admin"], connectPartnerAction: ["admin"], disconnectPartnerAction: ["admin"], addMemberAction: ["admin"], setMemberRoleAction: ["admin"],
  setMemberGrantsAction: ["admin"], removeMemberAction: ["admin"],
  // who works when and from where (a driver manager or an admin), and the terminal list itself (an admin)
  saveScheduleAction: ["roster"], applyScheduleAction: ["roster"], clearScheduleAction: ["roster"], saveTimeOffAction: ["roster"], removeTimeOffAction: ["roster"], setDriversHomeAction: ["roster"], setDriverCodeAction: ["roster"],
  addTerminalAction: ["admin"], renameTerminalAction: ["admin"], archiveTerminalAction: ["admin"], addRegionAction: ["admin"], renameRegionAction: ["admin"], archiveRegionAction: ["admin"], setTerminalRegionAction: ["admin"], setMemberScopeAction: ["admin"],
  // the ELD fleet import (an admin), and a dropped trailer's dwell figure (a dispatcher or a billing person; either one)
  importEldFleetAction: ["admin"], adjustTrailerDwellAction: ["dispatch", "bill"], waiveTrailerDwellAction: ["dispatch", "bill"], clearTrailerDwellAction: ["dispatch", "bill"], setLaneTargetAction: ["dispatch", "bill"], saveKpiNoteAction: ["dispatch", "bill"]
};

describe("every action asks for the capability the table says", () => {
  const names = [...text.matchAll(/^export async function (\w+Action)\(/gm)].map((m) => m[1]!);

  it("has an entry for every action, and no entry for one that is gone", () => {
    expect(names.filter((n) => !(n in TABLE)), "decide which office the new action belongs to, and add it to TABLE").toEqual([]);
    expect(Object.keys(TABLE).filter((n) => !names.includes(n))).toEqual([]);
  });

  it.each(Object.entries(TABLE))("%s needs %j", (name, expected) => {
    expect(needsOf(name)).toEqual(expected);
  });
});

describe("what each office may press", () => {
  const may = (role: Role, grants: string[] = []) => Object.entries(TABLE).filter(([, caps]) => canAny(role, grants, caps)).map(([n]) => n);
  const cannot = (role: Role, grants: string[] = []) => Object.keys(TABLE).filter((n) => !may(role, grants).includes(n));

  it("lets a viewer read, and nothing else", () => {
    expect(may("viewer").sort()).toEqual(["assignOptionsAction", "listQuotesAction", "previewImportAction", "priceQuoteAction", "readSampleRateConAction", "setAppearanceAction"]);
  });

  it("keeps accounting out of every dispatching action, and in every billing one except writing off and voiding a statement", () => {
    for (const n of ["assignAction", "sendAction", "cancelAction", "startTripAction", "completeTripAction", "saveQuoteAction", "saveDriverAction", "saveTruckAction"]) expect(may("accounting"), n).not.toContain(n);
    for (const n of ["invoiceLoadAction", "paidAction", "voidInvoiceAction", "undoPaidAction", "factorInvoiceAction", "startSettlementAction", "finalizeSettlementAction", "sendToPayrollAction", "saveCustomerAction", "correctTripAction", "saveExpensesAction", "removeDocumentAction"]) expect(may("accounting"), n).toContain(n);
    expect(may("accounting")).not.toContain("voidSettlementAction");
  });

  it("keeps a dispatcher out of billing and payroll, and gives them the billing office's work only with the grant", () => {
    for (const n of ["invoiceLoadAction", "paidAction", "voidInvoiceAction", "undoPaidAction", "startSettlementAction", "finalizeSettlementAction", "sendToPayrollAction"]) {
      expect(may("dispatcher"), n).not.toContain(n);
      expect(may("dispatcher", ["bill"]), n).toContain(n);
    }
    for (const n of ["voidSettlementAction", "saveThresholdsAction", "addMemberAction", "setMemberGrantsAction"]) expect(may("dispatcher", ["bill"]), n).not.toContain(n);
  });

  it("leaves the company, the rules, the team and the destruction of money to an admin alone", () => {
    for (const r of ROLES.filter((x) => x !== "admin")) {
      for (const n of ["saveThresholdsAction", "saveCompanyAction", "connectPartnerAction", "addMemberAction", "setMemberRoleAction", "setMemberGrantsAction", "removeMemberAction", "voidSettlementAction"]) expect(may(r, ["bill"]), `${r} ${n}`).not.toContain(n);
    }
    expect(cannot("admin")).toEqual([]);
    expect(can("admin", [], "writeoff")).toBe(true);
  });
});

describe("the write-off is checked where the money moves, not only on the button", () => {
  it("makes paidAction ask for write-off when it is asked to write something off", () => {
    const at = text.indexOf("export async function paidAction(");
    expect(text.slice(at, at + 700)).toMatch(/shortAction === "writeoff"\) await requireCan\("writeoff"\)/);
  });
});

describe("the files and the uploads", () => {
  const route = (...p: string[]) => readFileSync(path.join(__dirname, "..", "src", "app", "(desk)", ...p), "utf8");
  it("lets anyone who can read export and download", () => {
    for (const f of [["export", "[kind]", "route.ts"], ["documents", "[id]", "route.ts"]]) expect(route(...f), f.join("/")).toMatch(/guardRoute\("read"\)/);
  });
  it("lets whoever collects documents upload them", () => {
    expect(route("documents", "upload", "route.ts")).toMatch(/guardRoute\("documents"\)/);
  });
});
