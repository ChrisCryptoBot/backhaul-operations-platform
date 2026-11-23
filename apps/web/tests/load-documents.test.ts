import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { AUTO_TO_DRIVER, CHOSEN_TO_DRIVER, DOC_KINDS, DOC_LABEL, goesToDriver } from "@/lib/documents";
import { AFTER_DELIVERY_MS, deskFilePath, documentPlan, filesOnPhone, rowsForLoad, type DocIn } from "@/lib/load-documents";
import { supabaseTransport } from "@/server/bridge/transport";

/** Sync plan Step 4: which load files reach the driver's phone, checked against the phone project's SQL so the two lists cannot drift. */
const SQL = readFileSync(join(__dirname, "../../../../supabase/migrations/20261122000400_bridge_load_documents.sql"), "utf8");

const doc = (o: Partial<DocIn>): DocIn => ({ id: "doc-0001", kind: "bol", name: "BOL.pdf", mime: "application/pdf", bytes: 100, sha256: "a", toDriver: false, ...o });

describe("which documents go to the driver", () => {
  test("the bill of lading, instructions and lumper receipt always; other only when ticked; the rest never, ticked or not", () => {
    expect(DOC_KINDS.filter((k) => goesToDriver({ kind: k, toDriver: false }))).toEqual(["bol", "instructions", "lumper"]);
    expect(DOC_KINDS.filter((k) => goesToDriver({ kind: k, toDriver: true }))).toEqual(["bol", "instructions", "lumper", "other"]);
    for (const k of DOC_KINDS) expect(DOC_LABEL[k]).toBeTruthy();
  });

  test("the phone project's table allows exactly those kinds", () => {
    const kinds = /check \(kind in \(([^)]+)\)\)/.exec(SQL)![1]!.split(",").map((s) => s.trim().replaceAll("'", ""));
    expect(kinds).toEqual([...AUTO_TO_DRIVER, CHOSEN_TO_DRIVER]);
    expect(SQL).not.toMatch(/grant [^;]*load_documents to authenticated/);
  });

  test("a rate confirmation or a money receipt filed again under a kind that goes is still held back", () => {
    const rows = rowsForLoad({ orgId: "o", driverSub: "u", loadId: "L", docs: [doc({ id: "rc", kind: "rate_con", sha256: "rc" }), doc({ id: "sneak", kind: "instructions", sha256: "rc" }), doc({ id: "rcpt", kind: "receipt", sha256: "m" }), doc({ id: "sneak2", kind: "other", toDriver: true, sha256: "m" }), doc({ id: "good" })] });
    expect(rows.map((r) => r.desk_document_id)).toEqual(["good"]);
  });

  test("a path is the desk's id in that driver's folder, never the name a person typed", () => {
    expect(deskFilePath("desk_ws1", "user_9", "abc-1", "application/pdf")).toBe("org/desk_ws1/desk/user_9/abc-1.pdf");
    expect(deskFilePath("desk_ws1", "user_9", "abc-1", "application/x-thing")).toBe("org/desk_ws1/desk/user_9/abc-1.bin");
    expect(SQL).toContain("starts_with(path, 'org/' || org_id || '/desk/' || driver_sub || '/')");
  });

  test("on the phone while sent, accepted or on the road, and a week after delivery; never on a cancelled load", () => {
    const now = new Date("2026-11-22T12:00:00Z");
    const at = (ms: number) => new Date(now.getTime() - ms);
    for (const s of ["dispatched", "accepted", "in_progress"]) expect(filesOnPhone({ assignment: s, load: s, completedAt: null }, now)).toBe(true);
    for (const s of ["draft", "declined"]) expect(filesOnPhone({ assignment: s, load: "draft", completedAt: null }, now)).toBe(false);
    expect(filesOnPhone({ assignment: "completed", load: "completed", completedAt: at(AFTER_DELIVERY_MS - 1) }, now)).toBe(true);
    expect(filesOnPhone({ assignment: "completed", load: "completed", completedAt: at(AFTER_DELIVERY_MS) }, now)).toBe(false);
    expect(filesOnPhone({ assignment: "completed", load: "completed", completedAt: null }, now)).toBe(false);
    expect(filesOnPhone({ assignment: "accepted", load: "cancelled", completedAt: null }, now)).toBe(false);
  });

  test("only the difference is written and removed, per driver", () => {
    const row = (sub: string, id: string) => ({ ...rowsForLoad({ orgId: "o", driverSub: sub, loadId: "L", docs: [doc({ id })] })[0]!, id: `r-${sub}-${id}` });
    const plan = documentPlan([row("u1", "a"), row("u2", "b")], [row("u1", "a"), row("u1", "b")]);
    expect(plan.write.map((r) => [r.driver_sub, r.desk_document_id])).toEqual([["u2", "b"]]);
    expect(plan.remove.map((r) => r.id)).toEqual(["r-u1-b"]);
  });
});

describe("the real transport", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const t = supabaseTransport({ url: "https://bridge.test.invalid", key: "not-real" } as never, (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("[]", { status: 200 });
  }) as never);

  test("an upload goes to the desk's folder only, as its own type", async () => {
    await t.uploadDeskFile("org/o/desk/u/abc-1.pdf", new Uint8Array([1]), "application/pdf");
    expect(calls[0]!.url).toBe("https://bridge.test.invalid/storage/v1/object/bridge-files/org/o/desk/u/abc-1.pdf");
    expect(calls[0]!.init.headers).toMatchObject({ "Content-Type": "application/pdf", "x-upsert": "true" });
    for (const bad of ["org/o/driver/u/abc.pdf", "org/o/desk/u/../x.pdf", "org/o/desk/u/a/b.pdf", "desk/u/a.pdf"]) await expect(t.uploadDeskFile(bad, new Uint8Array([1]), "application/pdf")).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(1);
  });

  test("an id that is not plain never reaches a filter", async () => {
    await expect(t.deleteLoadDocuments("o", ["x)&or=(1.eq.1"])).rejects.toMatchObject({ code: "rejected" });
    expect(calls).toHaveLength(1);
  });
});
