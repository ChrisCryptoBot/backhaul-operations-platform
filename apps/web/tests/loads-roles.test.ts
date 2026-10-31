import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Who may do what on a load, pinned action by action. auth-guard.test.ts proves every action asks the member table; this proves it asks for the right role. Reading a load or a file is for a
 * viewer; anything that changes a load, its trip, its money or its documents is for a dispatcher; the company, the rules, the connections and the team are an owner's.
 */
const text = readFileSync(path.join(__dirname, "..", "src", "app", "(desk)", "actions.ts"), "utf8").replace(/\r\n/g, "\n");
const roleOf = (name: string): string | null => {
  const at = text.indexOf(`export async function ${name}(`);
  if (at < 0) return null;
  return text.slice(at, at + 500).match(/requireMember\("(viewer|dispatcher|owner)"\)/)?.[1] ?? null;
};

const LOAD_WRITES = [
  "assignAction", "assignFromQueueAction", "unassignAction", "sendAction", "respondAction", "cancelAction", "tonuAction", "rescheduleAction", "reopenCancelledAction",
  "saveLoadDetailsAction", "deleteLoadAction", "restoreLoadAction", "startTripAction", "undoStartAction", "reopenDeliveredAction", "completeTripAction", "correctTripAction", "saveExpensesAction",
  "invoiceLoadAction", "paidAction", "voidInvoiceAction", "undoPaidAction", "factorInvoiceAction", "factoringUpdateAction", "removeDocumentAction", "saveRateConAction"
];

describe("load actions by role", () => {
  it.each(LOAD_WRITES)("%s is a dispatcher's", (name) => {
    expect(roleOf(name), `${name} has to exist and start with requireMember("dispatcher")`).toBe("dispatcher");
  });

  it("leaves nothing that changes a load to a viewer", () => {
    const names = [...text.matchAll(/^export async function (\w+Action)\(/gm)].map((m) => m[1]!);
    const viewer = names.filter((n) => roleOf(n) === "viewer");
    // What a viewer may ask of the server writes nothing for the company: reading the drivers for the picker, a sample rate confirmation, pricing and listing quotes, a preview of an import
    // (it commits nothing), and their own light or dark setting. A new action that is not on this list has to be a dispatcher's, or be added here on purpose.
    expect(viewer.sort()).toEqual(["assignOptionsAction", "listQuotesAction", "previewImportAction", "priceQuoteAction", "readSampleRateConAction", "setAppearanceAction"]);
  });

  it("keeps the exports and the document download to a signed-in member, a viewer at least", () => {
    for (const f of ["export/[kind]/route.ts", "documents/[id]/route.ts"]) {
      const src = readFileSync(path.join(__dirname, "..", "src", "app", "(desk)", ...f.split("/")), "utf8");
      expect(src, f).toMatch(/guardRoute\("viewer"\)/);
    }
  });

  it("keeps the upload to a dispatcher", () => {
    expect(readFileSync(path.join(__dirname, "..", "src", "app", "(desk)", "documents", "upload", "route.ts"), "utf8")).toMatch(/guardRoute\("dispatcher"\)/);
  });
});
