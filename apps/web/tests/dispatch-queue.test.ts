import { describe, expect, it } from "vitest";
import { declineNoteOf, NEEDS_DRIVER, queueColumnOf } from "../src/lib/dispatch-queue";
import { deskStatusOf } from "../src/server/tl/queries";

describe("where a load sits on the Dispatch queue", () => {
  it("splits Needs a driver into nobody, picked but never sent, and declined", () => {
    expect(queueColumnOf({ status: "draft", assignmentStatus: null })).toBe("no_driver");
    expect(queueColumnOf({ status: "draft", assignmentStatus: "draft" })).toBe("ready_to_send");
    expect(queueColumnOf({ status: "draft", assignmentStatus: "declined" })).toBe("declined");
    for (const c of ["no_driver", "ready_to_send", "declined"] as const) expect(NEEDS_DRIVER).toContain(c);
  });

  it("puts a sent load in Sent, an accepted or started one in Moving, and a dropped one in the yard", () => {
    expect(queueColumnOf({ status: "draft", assignmentStatus: "dispatched" })).toBe("sent");
    expect(queueColumnOf({ status: "accepted", assignmentStatus: "accepted" })).toBe("moving");
    expect(queueColumnOf({ status: "in_progress", assignmentStatus: "in_progress" })).toBe("moving");
    expect(queueColumnOf({ status: "in_progress", assignmentStatus: "in_progress" }, true)).toBe("yard");
  });

  it("reads the phone's own statuses the desk's way: scheduled is accepted, dispatched is a sent draft", () => {
    expect(queueColumnOf({ status: deskStatusOf("scheduled"), assignmentStatus: null })).toBe("moving");
    // A load the phone marked dispatched with no desk assignment row is read as sent (queries.ts assignmentStatus).
    expect(queueColumnOf({ status: deskStatusOf("dispatched"), assignmentStatus: "dispatched" })).toBe("sent");
  });

  it("leaves finished loads off the queue", () => {
    expect(queueColumnOf({ status: "completed", assignmentStatus: "completed" })).toBeNull();
    expect(queueColumnOf({ status: "cancelled", assignmentStatus: null })).toBeNull();
  });

  it("keeps the driver's reason for a no, and nothing else", () => {
    expect(declineNoteOf({ response: "declined", note: "  Out of hours " })).toBe("Out of hours");
    expect(declineNoteOf({ response: "accepted", note: "fine" })).toBeNull();
    expect(declineNoteOf(null)).toBeNull();
  });
});
