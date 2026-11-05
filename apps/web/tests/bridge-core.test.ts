import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_ENV, MAX_ATTEMPTS, backoffMinutes, bridgeConfig, bridgeMode, closeDispatchRow, interpretRow, newDispatchRow, nextAttemptAt, parseDriverResponse, updateDispatchRow, wholeOf } from "@/server/bridge/core";
import { BridgeTransportError, memoryTransport, supabaseTransport } from "@/server/bridge/transport";
import { FORBIDDEN_KEY } from "@/server/tl/projector";

const ORG = "org_fleet_1";
const DRIVER = "user_driver_1";

describe("who is reached through the driver link", () => {
  it("is bridged only with a fleet org, a server that holds the keys and a driver with a phone account; otherwise manual, and says why", () => {
    expect(bridgeMode({ workspaceOrgId: ORG, serverReady: true, driverPhoneUserId: DRIVER })).toEqual({ mode: "bridged" });
    for (const [i, why] of [
      [{ workspaceOrgId: null, serverReady: true, driverPhoneUserId: DRIVER }, /not connected to its drivers/],
      [{ workspaceOrgId: ORG, serverReady: false, driverPhoneUserId: DRIVER }, /not switched on/],
      [{ workspaceOrgId: ORG, serverReady: true, driverPhoneUserId: null }, /no phone account/]
    ] as const) {
      const m = bridgeMode(i);
      expect(m.mode).toBe("manual");
      expect(m.mode === "manual" && m.reason).toMatch(why);
    }
  });

  it("reads the transport's address and key from the environment, and refuses a missing key or a non-https address", () => {
    expect(bridgeConfig({})).toBeNull();
    expect(bridgeConfig({ [BRIDGE_ENV.url]: "https://x.supabase.co/", [BRIDGE_ENV.key]: "k" })).toEqual({ url: "https://x.supabase.co", key: "k" });
    expect(bridgeConfig({ [BRIDGE_ENV.url]: "http://x.supabase.co", [BRIDGE_ENV.key]: "k" })).toBeNull();
    expect(bridgeConfig({ [BRIDGE_ENV.url]: "https://x.supabase.co" })).toBeNull();
  });
});

describe("the rows the desk writes", () => {
  it("writes only the columns it owns, with the version it holds, and never the phone's", () => {
    const row = newDispatchRow({ orgId: ORG, phoneUserId: DRIVER, loadId: "L1", summary: { schema: 3 }, assignmentVersion: 4 });
    expect(Object.keys(row).sort()).toEqual(["assigned_driver_id", "assignment_version", "kind", "load_summary", "org_id", "source_load_id", "source_system", "status", "updated_by"]);
    expect(row).not.toHaveProperty("driver_response");
    expect(row).not.toHaveProperty("execution_version");
    expect(row.status).toBe("dispatched");
  });

  it("a re-offer clears the driver's answer; a plain update does not; a close never deletes", () => {
    expect(updateDispatchRow({ summary: {}, assignmentVersion: 5, reoffer: true })).toMatchObject({ driver_response: null, assignment_version: 5, status: "dispatched" });
    expect(updateDispatchRow({ summary: {}, assignmentVersion: 5, reoffer: false })).not.toHaveProperty("driver_response");
    expect(closeDispatchRow("cancelled", 6, null)).toEqual({ status: "cancelled", assignment_version: 6, updated_by: "desk" });
    expect(closeDispatchRow("reassigned", 6, "new-row")).toMatchObject({ status: "reassigned", replaced_by_dispatch_id: "new-row" });
  });
});

describe("the driver's answer is read strictly", () => {
  it("accepts the four states and nothing else, and ignores a body that is not an object", () => {
    for (const state of ["accepted", "declined", "in_progress", "completed"]) expect(parseDriverResponse({ state }, ORG)?.state).toBe(state);
    for (const bad of [null, "accepted", [], { state: "rolled" }, { state: 4 }, {}]) expect(parseDriverResponse(bad, ORG)).toBeNull();
  });

  it("bounds numbers, validates times, and keeps proof paths inside the fleet's folder", () => {
    const a = parseDriverResponse(
      {
        state: "completed",
        accepted_at: "not a time",
        started_at: "2026-11-04T10:00:00Z",
        completion: { completed_at: "2026-11-05T12:00:00Z", actual_total_miles: 612.44 },
        pod_refs: [{ stop_seq: 1, path: `${ORG}/loads/L1/stop1.jpg` }, { stop_seq: 2, path: "../../etc/passwd" }, { path: "/absolute/x.jpg" }, { path: "a/b" }, { stop_seq: -1, path: `${ORG}/x/y.jpg` }]
      },
      ORG
    )!;
    expect(a.acceptedAt).toBeNull();
    expect(a.startedAt).toBe("2026-11-04T10:00:00.000Z");
    expect(a.actualMiles).toBe(612.4);
    expect(a.podRefs.map((r) => r.path)).toEqual([`${ORG}/loads/L1/stop1.jpg`, `${ORG}/x/y.jpg`]);
    expect(parseDriverResponse({ state: "completed", completion: { actual_total_miles: 999999 } }, ORG)!.actualMiles).toBeNull();
  });
});

describe("what to do with a row the phone moved", () => {
  const row = (over: Record<string, unknown> = {}) => ({ assigned_driver_id: DRIVER, execution_version: 1, status: "dispatched", driver_response: { state: "accepted" }, ...over });
  const at = (over: Record<string, unknown>, desk: string | null, seen = 0, phone: string | null = DRIVER) => interpretRow({ row: row(over) as never, orgId: ORG, phoneUserId: phone, deskStatus: desk, seenExecutionVersion: seen });

  it("applies the next step, and the steps in between when the desk read late", () => {
    expect(at({}, "dispatched")).toEqual({ kind: "apply", steps: ["accepted"] });
    expect(at({ driver_response: { state: "in_progress" } }, "dispatched")).toEqual({ kind: "apply", steps: ["accepted", "in_progress"] });
    expect(at({ driver_response: { state: "completed" } }, "accepted")).toEqual({ kind: "apply", steps: ["in_progress", "completed"] });
    expect(at({ driver_response: { state: "declined" } }, "dispatched")).toEqual({ kind: "apply", steps: ["declined"] });
  });

  it("ignores what is already applied, old news and an unreadable answer", () => {
    expect(at({}, "dispatched", 1).kind).toBe("ignore");
    expect(at({}, "in_progress").kind).toBe("ignore");
    expect(at({ driver_response: null }, "dispatched").kind).toBe("ignore");
  });

  it("flags, never applies, an answer for a load the desk took off the driver, from the wrong phone, or declined after the driver was on it", () => {
    expect(at({ status: "cancelled" }, "dispatched").kind).toBe("flag");
    expect(at({ status: "reassigned" }, "dispatched").kind).toBe("flag");
    expect(at({}, "dispatched", 0, "user_someone_else").kind).toBe("flag");
    expect(at({ driver_response: { state: "declined" } }, "accepted").kind).toBe("flag");
    expect(at({}, null).kind).toBe("flag");
    expect(at({}, "declined").kind).toBe("flag");
  });
});

describe("retries", () => {
  it("waits 1, 5, 15, 60 minutes and then a day, and gives up after five", () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffMinutes)).toEqual([1, 5, 15, 60, 1440, 1440]);
    expect(MAX_ATTEMPTS).toBe(5);
    const now = new Date("2026-11-04T12:00:00Z");
    expect(nextAttemptAt(now, 2).toISOString()).toBe("2026-11-04T12:05:00.000Z");
  });
  it("parses counts without rounding or guessing", () => {
    expect(wholeOf("42")).toBe(42);
    expect(wholeOf(42n)).toBe(42);
    expect(wholeOf(null)).toBe(0);
    expect(wholeOf("x")).toBe(0);
  });
});

describe("the real transport, with fetch mocked", () => {
  const KEY = "sb_service_THIS_MUST_NEVER_APPEAR_ANYWHERE";
  const cfg = { url: "https://proj.supabase.co", key: KEY };
  const make = (reply: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(url, init);
    }) as unknown as typeof fetch;
    return { t: supabaseTransport(cfg, f), calls };
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the open row with the service key and the bridge profile, filtered by org, load and driver", async () => {
    const { t, calls } = make(() => json([{ id: "r1", assignment_version: 2 }]));
    expect((await t.findOpenRow(ORG, "L1", DRIVER))?.id).toBe("r1");
    const c = calls[0]!;
    expect(c.url).toContain("/rest/v1/external_dispatch?org_id=eq.org_fleet_1&source_load_id=eq.L1&assigned_driver_id=eq.user_driver_1&status=in.(draft,dispatched)");
    const h = c.init.headers as Record<string, string>;
    expect(h["Accept-Profile"]).toBe("bridge");
    expect(h.apikey).toBe(KEY);
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("writes with the bridge profile; a patch carries the version it expects, and an empty answer means the row moved", async () => {
    const { t, calls } = make((url, init) => (init.method === "PATCH" ? json([]) : json([{ id: "n1" }])));
    expect((await t.insert({ a: 1 })).id).toBe("n1");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Profile"]).toBe("bridge");
    expect(await t.patch("r1", 3, { status: "cancelled" })).toBeNull();
    expect(calls[1]!.url).toContain("?id=eq.r1&assignment_version=eq.3");
    expect(calls[1]!.init.method).toBe("PATCH");
  });

  it("reads changes after the cursor, oldest first, with a bounded page", async () => {
    const { t, calls } = make(() => json([]));
    await t.changedSince(ORG, 41, 9999);
    expect(calls[0]!.url).toContain("sync_seq=gt.41&order=sync_seq.asc&limit=500");
  });

  it("refuses anything in an id that is not plain, so a value can never become a filter of its own", async () => {
    const { t, calls } = make(() => json([]));
    await expect(t.findOpenRow(ORG, "L1&status=eq.cancelled", DRIVER)).rejects.toBeInstanceOf(BridgeTransportError);
    await expect(t.patch("x)or(1=1", 1, {})).rejects.toBeInstanceOf(BridgeTransportError);
    expect(calls).toHaveLength(0);
  });

  it("says unreachable for a network failure or a 5xx and rejected for a 4xx, in fixed words that never contain the key or the body", async () => {
    const down = supabaseTransport(cfg, (async () => {
      throw new Error(`connect ECONNREFUSED with ${KEY}`);
    }) as unknown as typeof fetch);
    const refused = make(() => json({ message: `no, ${KEY}` }, 403)).t;
    const broken = make(() => json({ message: KEY }, 502)).t;
    for (const [t, code] of [[down, "unreachable"], [refused, "rejected"], [broken, "unreachable"]] as const) {
      const e = await t.findOpenRow(ORG, "L1", DRIVER).catch((x) => x);
      expect(e).toBeInstanceOf(BridgeTransportError);
      expect(e.code).toBe(code);
      expect(String(e.message)).not.toContain(KEY);
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });
});

describe("the in-memory table behaves like the real one", () => {
  it("version-checks a patch, rises its sequence on every write, and the phone's answer moves only its own counter", async () => {
    const t = memoryTransport();
    const row = await t.insert(newDispatchRow({ orgId: ORG, phoneUserId: DRIVER, loadId: "L1", summary: {}, assignmentVersion: 1 }));
    expect(await t.patch(row.id, 9, { status: "cancelled" })).toBeNull();
    const moved = await t.patch(row.id, 1, { assignment_version: 2 });
    expect(moved!.sync_seq).toBeGreaterThan(row.sync_seq);
    t.phone(row.id, { state: "accepted" });
    const after = (await t.changedSince(ORG, 0, 10)).find((r) => r.id === row.id)!;
    expect(after.execution_version).toBe(1);
    expect(after.assignment_version).toBe(2);
    expect((await t.findOpenRow(ORG, "L1", DRIVER))?.id).toBe(row.id);
    expect(await t.findOpenRow(ORG, "L1", "someone_else")).toBeNull();
  });
});

describe("confidentiality at the boundary", () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
  it("the service checks the exact summary for anything a driver must not see right before it leaves, and keeps no payload in the outbox", () => {
    const svc = src("src/server/bridge/service.ts");
    expect(svc).toContain("assertDriverSafe(summary");
    expect(svc.indexOf("assertDriverSafe(summary")).toBeLessThan(svc.indexOf("transport.insert("));
    expect(fs.readFileSync(path.join(__dirname, "../../../prisma/schema.prisma"), "utf8")).not.toMatch(/model BridgeOutbox \{[^}]*payload/);
  });
  it("no key a row carries can be money", () => {
    const row = newDispatchRow({ orgId: ORG, phoneUserId: DRIVER, loadId: "L1", summary: {}, assignmentVersion: 1 });
    for (const k of Object.keys(row)) expect(FORBIDDEN_KEY.test(k), k).toBe(false);
  });
  it("the secrets are named, read at the time of the call, and appear nowhere else in the bridge code", () => {
    const all = ["core.ts", "outbox.ts", "service.ts", "transport.ts"].map((f) => src(`src/server/bridge/${f}`)).join("\n");
    expect(all).not.toMatch(/console\.(log|info|warn|error)/);
    expect(all).not.toMatch(/process\.env\.BRIDGE_/);
  });
});
