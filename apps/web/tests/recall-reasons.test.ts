import { describe, expect, test } from "vitest";
import { RECALL_CODES, RECALL_LABELS, RECALL_NOTE_MAX, RECALL_OFFERED, isOfferedRecallCode, isRecallCode, recallDeliveryText, recallReasonText, type RecallDelivery } from "@/lib/recall-reasons";
import { readFileSync } from "node:fs";

describe("recall reasons (docs/RELAY_DESIGN.md)", () => {
  test("the list is exactly the five signed-off codes", () => {
    expect([...RECALL_CODES]).toEqual(["ASSIGNED_IN_ERROR", "HOS_TIMEOUT", "MECHANICAL_BREAKDOWN", "DRIVER_UNRESPONSIVE", "DRIVER_NO_SHOW", "SCHEDULED_RELAY"]);
  });
  test("every code has a label", () => {
    for (const c of RECALL_CODES) expect(RECALL_LABELS[c].length).toBeGreaterThan(3);
  });
  test("a clean recall offers four; the scheduled relay is reserved for the handoff", () => {
    expect([...RECALL_OFFERED]).toEqual(["ASSIGNED_IN_ERROR", "HOS_TIMEOUT", "MECHANICAL_BREAKDOWN", "DRIVER_UNRESPONSIVE"]);
    expect(isRecallCode("SCHEDULED_RELAY")).toBe(true);
    expect(isOfferedRecallCode("SCHEDULED_RELAY")).toBe(false);
    expect(isOfferedRecallCode("HOS_TIMEOUT")).toBe(true);
  });
  test("anything that is not a code is not one", () => {
    for (const v of ["", "assigned_in_error", "OTHER", null, undefined, 3]) expect(isRecallCode(v)).toBe(false);
  });
  test("the audit words are the label, with the note after it when there is one, kept to the note limit", () => {
    expect(recallReasonText("ASSIGNED_IN_ERROR")).toBe("Assigned in error");
    expect(recallReasonText("HOS_TIMEOUT", "  out of 70  ")).toBe("Out of hours: out of 70");
    expect(recallReasonText("HOS_TIMEOUT", "x".repeat(RECALL_NOTE_MAX + 50)).length).toBe(RECALL_LABELS.HOS_TIMEOUT.length + 2 + RECALL_NOTE_MAX);
  });
  test("a recall's delivery is never worded as the driver having seen it", () => {
    const deliveries: RecallDelivery[] = ["delivered", "waiting", "failed", "none"];
    for (const d of deliveries) {
      expect(recallDeliveryText(d)).not.toMatch(/acknowledged|confirmed they|saw it/i);
    }
    expect(recallDeliveryText("delivered")).toMatch(/has not confirmed/);
    expect(recallDeliveryText("waiting")).toMatch(/Call the driver/);
  });
});

describe("the recall action is for the dispatch role only (source pin)", () => {
  test("unassignAction asks requireCan('dispatch') before it does anything", () => {
    const src = readFileSync("src/app/(desk)/actions.ts", "utf8").split(String.fromCharCode(13)).join("");
    const body = src.slice(src.indexOf("export async function unassignAction"));
    expect(body.slice(0, 200)).toContain('await requireCan("dispatch")');
    expect(body.slice(0, 900)).toContain("reasonCode");
  });
});
