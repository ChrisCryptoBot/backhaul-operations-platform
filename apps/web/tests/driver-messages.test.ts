import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { attachmentPathAllowed, BRIDGE_KEEP_MS, DESK_DELIVERY_LABEL, deskBodyOf, deskDelivery, deskSenderId, driverFileFolder, fileNameOf, isPullable, purgeDue, toDriverRow, DRIVER_MESSAGE_BODY_MAX } from "@/lib/driver-messages";

/** Phase 2 step 3: the desk's half of the message rules, checked against the phone project's SQL so the two cannot drift. */
const PHONE_SQL = join(__dirname, "../../../../supabase/migrations/20261121000300_bridge_driver_messages.sql");
const RETENTION_SQL = join(__dirname, "../../../../supabase/migrations/20261121000400_bridge_driver_messages_retention.sql");

describe("driver messages, desk rules", () => {
  test("a desk message becomes a to_driver row keyed on the desk message id, files counted not sent", () => {
    const row = toDriverRow({ orgId: "desk_ws1", phoneUserId: "user_9", deskDriverId: "drv_1", messageId: "cmsg123456", body: "Gate code 4471", fileCount: 2, loadNumber: "DM-40006" });
    expect(row).toEqual({ org_id: "desk_ws1", driver_sub: "user_9", desk_driver_id: "drv_1", direction: "to_driver", sender_id: "desk:desk_ws1", client_id: "cmsg123456", body: "Gate code 4471", attachments: [], desk_file_count: 2, load_ref: "DM-40006" });
    expect(toDriverRow({ orgId: "o", phoneUserId: "u", deskDriverId: "d", messageId: "m1234567", body: "x".repeat(3000), fileCount: 500, loadNumber: null }).body).toHaveLength(DRIVER_MESSAGE_BODY_MAX);
  });

  test("the sender is the fleet, never a person on the desk", () => {
    expect(deskSenderId("desk_ws1")).toBe("desk:desk_ws1");
  });

  test("a driver's files the desk could not keep are named in the text with the reason; no storage path is copied into the text", () => {
    expect(deskBodyOf({ body: "Here is the BOL" })).toBe("Here is the BOL");
    expect(deskBodyOf({ body: "Here is the BOL" }, { full: 1 })).toBe("Here is the BOL\n(1 file from the phone not kept: this desk's storage is full)");
    expect(deskBodyOf({ body: "" }, { refused: 2, gone: 1 })).toBe("(2 files from the phone not kept: the desk's file checks refused it)\n(1 file from the phone not kept: it was no longer on the phone link)");
    expect(deskBodyOf({ body: "Hi" }, { full: 0 })).toBe("Hi");
    expect(fileNameOf("org/o/driver/u/c-1-0.jpg")).toBe("c-1-0.jpg");
  });

  test("retention: a row leaves the bridge one day after it was read, only when delivered and read", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    expect(BRIDGE_KEEP_MS).toBe(24 * 60 * 60 * 1000);
    expect(purgeDue({ delivered_at: "2026-11-20T00:00:00Z", read_at: "2026-11-21T11:59:59Z" }, now)).toBe(true);
    expect(purgeDue({ delivered_at: "2026-11-20T00:00:00Z", read_at: "2026-11-21T12:00:01Z" }, now)).toBe(false);
    expect(purgeDue({ delivered_at: "2026-11-01T00:00:00Z", read_at: null }, now)).toBe(false);
    expect(purgeDue({ delivered_at: null, read_at: "2026-11-01T00:00:00Z" }, now)).toBe(false);
  });

  test("a sent message reads Read, Delivered, Sending (bridged, not there yet) or Saved on the desk (no phone link)", () => {
    const d = new Date();
    expect(deskDelivery({ deliveredAt: d, readAt: d, onLink: true }, true)).toBe("read");
    expect(deskDelivery({ deliveredAt: d, readAt: null, onLink: true }, true)).toBe("delivered");
    expect(deskDelivery({ deliveredAt: null, readAt: null, onLink: true }, true)).toBe("sending");
    expect(deskDelivery({ deliveredAt: null, readAt: null, onLink: false }, false)).toBe("saved");
    expect(DESK_DELIVERY_LABEL.read).toBe("Read");
    expect(DESK_DELIVERY_LABEL.saved).toBe("Saved on the desk");
  });

  test("a message written before the driver linked (no bridge item) reads Saved on the desk, not Sending, once the link is live", () => {
    expect(deskDelivery({ deliveredAt: null, readAt: null, onLink: false }, true)).toBe("saved");
    // A queued message whose link has since ended is not on its way either.
    expect(deskDelivery({ deliveredAt: null, readAt: null, onLink: true }, false)).toBe("saved");
  });

  test("the retention migration lets the desk's service role delete, and only that", () => {
    const sql = readFileSync(RETENTION_SQL, "utf8");
    expect(sql).toMatch(/grant delete on bridge\.driver_messages to service_role;/);
    expect(sql).not.toMatch(/grant [^;]*delete[^;]* to (authenticated|anon)/);
  });

  test("only this fleet's untaken driver rows are pulled", () => {
    expect(isPullable({ org_id: "o", direction: "to_desk", delivered_at: null }, "o")).toBe(true);
    expect(isPullable({ org_id: "o", direction: "to_desk", delivered_at: "2026-11-21T00:00:00Z" }, "o")).toBe(false);
    expect(isPullable({ org_id: "other", direction: "to_desk", delivered_at: null }, "o")).toBe(false);
    expect(isPullable({ org_id: "o", direction: "to_driver", delivered_at: null }, "o")).toBe(false);
  });

  test("file paths stay in the driver's folder for this carrier", () => {
    expect(driverFileFolder("o", "u")).toBe("org/o/driver/u/");
    expect(attachmentPathAllowed("o", "u", "org/o/driver/u/bol.jpg")).toBe(true);
    expect(attachmentPathAllowed("o", "u", "org/o/driver/other/bol.jpg")).toBe(false);
    expect(attachmentPathAllowed("o", "u", "org/o/driver/u/../x/bol.jpg")).toBe(false);
  });

  test("the phone's SQL has the same keys, directions, limits and folder", () => {
    const sql = readFileSync(PHONE_SQL, "utf8");
    expect(sql).toMatch(/unique \(direction, sender_id, client_id\)/);
    expect(sql).toMatch(/direction in \('to_driver', 'to_desk'\)/);
    expect(sql).toMatch(new RegExp(`char_length\\(body\\) <= ${DRIVER_MESSAGE_BODY_MAX}`));
    expect(sql).toMatch(/'org\/' \|\| v_link\.org_id \|\| '\/driver\/' \|\| v_caller \|\| '\/'/);
    expect(sql).toMatch(/desk_file_count\s+int/);
  });
});
