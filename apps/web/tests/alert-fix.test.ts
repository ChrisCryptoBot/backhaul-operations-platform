import { describe, expect, test } from "vitest";
import { alertKindToFix } from "@/lib/ui/alert-fix";
import type { LoadAlertKind } from "@/lib/ui/load-alerts";

describe("alertKindToFix", () => {
  test("maps checklist-task obligations to a single-field update_load_fields", () => {
    const cases: Array<[LoadAlertKind, string]> = [
      ["TASK_MG", "mgStatusTask"],
      ["TASK_TMW", "tmwStatusTask"],
      ["TASK_SCALE_BEFORE", "scaleBeforeTask"],
      ["TASK_SCALE_AFTER", "scaleAfterTask"]
    ];
    for (const [kind, field] of cases) {
      const fix = alertKindToFix(kind, "load-1", "REF-1");
      expect(fix).not.toBeNull();
      expect(fix!.tool).toBe("update_load_fields");
      expect(fix!.input).toEqual({ loadId: "load-1", fields: { [field]: "DONE" } });
      expect(fix!.summary).toContain("REF-1");
    }
  });

  test("maps POD-send to podStatus SENT_TO_BROKER", () => {
    const fix = alertKindToFix("POD_SEND_OBLIGATION", "load-2", "REF-2");
    expect(fix!.input).toEqual({ loadId: "load-2", fields: { podStatus: "SENT_TO_BROKER" } });
  });

  test("maps reschedule-needs-driver to a confirm of the next-day driver", () => {
    const fix = alertKindToFix("RESCHEDULE_NEEDS_DRIVER", "load-3", "REF-3");
    expect(fix!.input).toEqual({ loadId: "load-3", fields: { rescheduleDriverConfirmed: "DONE" } });
  });

  test("returns null for kinds needing free input or human judgement", () => {
    const noFix: LoadAlertKind[] = [
      "COVERAGE_GAP", "APPT_MISSED", "TONU_UNBILLED", "MANUAL_FLAG",
      "POD_NEEDS_ATTENTION", "STATUS_STALE", "MISSING_MILES", "HANDOFF_STALL"
    ];
    for (const kind of noFix) {
      expect(alertKindToFix(kind, "load-x", "REF-X")).toBeNull();
    }
  });
});
