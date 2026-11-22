import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { attachmentPathAllowed, deskBodyOf, deskSenderId, driverFileFolder, isPullable, toDriverRow, DRIVER_MESSAGE_BODY_MAX } from "@/lib/driver-messages";

/** Phase 2 step 3: the desk's half of the message rules, checked against the phone project's SQL so the two cannot drift. */
const PHONE_SQL = join(__dirname, "../../../../supabase/migrations/20261121000300_bridge_driver_messages.sql");

describe("driver messages, desk rules", () => {
  test("a desk message becomes a to_driver row keyed on the desk message id, files counted not sent", () => {
    const row = toDriverRow({ orgId: "desk_ws1", phoneUserId: "user_9", deskDriverId: "drv_1", messageId: "cmsg123456", body: "Gate code 4471", fileCount: 2, loadNumber: "DM-40006" });
    expect(row).toEqual({ org_id: "desk_ws1", driver_sub: "user_9", desk_driver_id: "drv_1", direction: "to_driver", sender_id: "desk:desk_ws1", client_id: "cmsg123456", body: "Gate code 4471", attachments: [], desk_file_count: 2, load_ref: "DM-40006" });
    expect(toDriverRow({ orgId: "o", phoneUserId: "u", deskDriverId: "d", messageId: "m1234567", body: "x".repeat(3000), fileCount: 500, loadNumber: null }).body).toHaveLength(DRIVER_MESSAGE_BODY_MAX);
  });

  test("the sender is the fleet, never a person on the desk", () => {
    expect(deskSenderId("desk_ws1")).toBe("desk:desk_ws1");
  });

  test("a driver's files are named in the text until the desk fetches them; no storage path is copied into the text", () => {
    expect(deskBodyOf({ body: "Here is the BOL", attachments: [{ path: "org/o/driver/u/a.jpg" }] })).toBe("Here is the BOL\n(1 file sent from the phone)");
    expect(deskBodyOf({ body: "", attachments: [{ path: "org/o/driver/u/a.jpg" }, { path: "org/o/driver/u/b.jpg" }] })).toBe("(2 files sent from the phone)");
    expect(deskBodyOf({ body: "Hi", attachments: [] })).toBe("Hi");
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
