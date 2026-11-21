import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  INVITE_ALPHABET,
  INVITE_LENGTH,
  decideLink,
  deskOrgIdFor,
  formatInviteCode,
  hashInviteCode,
  inviteExpiresAt,
  linkStateOf,
  newInviteCode,
  newLinkRow,
  normalizeInviteCode,
  suggestedLinkRole,
  type LinkRow
} from "@/lib/driver-link";
import { BridgeTransportError, memoryTransport, supabaseTransport } from "@/server/bridge/transport";

const NOW = new Date("2026-11-21T12:00:00Z");

describe("invite codes", () => {
  it("are ten letters from an alphabet with no look-alikes, from the random source", () => {
    const code = newInviteCode();
    expect(code).toHaveLength(INVITE_LENGTH);
    expect([...code].every((c) => INVITE_ALPHABET.includes(c))).toBe(true);
    for (const c of "0O1IL") expect(INVITE_ALPHABET).not.toContain(c);
    let i = 0;
    expect(newInviteCode(() => i++ % INVITE_ALPHABET.length)).toBe("ABCDEFGHJK");
  });

  it("are shown with a dash, and typed back in any case, with or without it", () => {
    expect(formatInviteCode("ABCDEFGHJK")).toBe("ABCDE-FGHJK");
    expect(normalizeInviteCode(" abcde-fghjk ")).toBe("ABCDEFGHJK");
    expect(hashInviteCode("abcde fghjk")).toBe(hashInviteCode("ABCDE-FGHJK"));
  });

  it("are kept only as sha256 of the normalised code", () => {
    expect(hashInviteCode("ABCDE-FGHJK")).toBe(createHash("sha256").update("ABCDEFGHJK").digest("hex"));
    expect(hashInviteCode("ABCDE-FGHJK")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("use the same normalising rule as the bridge's SQL (phone project migration)", () => {
    const file = path.resolve(__dirname, "../../../../supabase/migrations/20261121000100_bridge_driver_links.sql");
    if (!fs.existsSync(file)) return; // the desk checked out on its own
    const sql = fs.readFileSync(file, "utf8");
    expect(sql).toContain("encode(sha256(convert_to(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'UTF8')), 'hex')");
  });

  it("last a week", () => {
    expect(inviteExpiresAt(NOW).toISOString()).toBe("2026-11-28T12:00:00.000Z");
  });
});

describe("the tenant key and the row the desk writes", () => {
  it("is the workspace's own key once set, else one made from its id", () => {
    expect(deskOrgIdFor({ id: "ws1", bridgeOrgId: null })).toBe("desk_ws1");
    expect(deskOrgIdFor({ id: "ws1", bridgeOrgId: "org_abc" })).toBe("org_abc");
  });

  it("writes only the desk's columns, never the phone's", () => {
    const row = newLinkRow({ orgId: "desk_ws1", driverId: "d1", carrierName: "  Northline Freight ", role: "company", codeHash: "h", expiresAt: NOW });
    expect(Object.keys(row).sort()).toEqual(["carrier_name", "code_hash", "desk_driver_id", "driver_role", "expires_at", "org_id"]);
    expect(row.carrier_name).toBe("Northline Freight");
    expect(newLinkRow({ orgId: "o", driverId: "d", carrierName: " ", role: "company", codeHash: "h", expiresAt: NOW }).carrier_name).toBe("Your carrier");
  });

  it("suggests a role from how the driver is paid", () => {
    expect(suggestedLinkRole("contractor")).toBe("owner_op_leased");
    expect(suggestedLinkRole("employee")).toBe("company");
    expect(suggestedLinkRole(null)).toBe("company");
  });
});

describe("what the pull does with a link row", () => {
  const row = (over: Partial<LinkRow> = {}): LinkRow => ({ id: "l1", org_id: "o", desk_driver_id: "d1", driver_role: "company", claimed_by: "user_phone_1", claimed_at: NOW.toISOString(), revoked_at: null, ended_by: null, ...over });
  const drivers = (phone: string | null = null) => new Map([["d1", { phoneUserId: phone }], ["d2", { phoneUserId: "user_phone_2" }]]);
  const nobody = () => null;

  it("links a claimed, live row to the driver", () => {
    expect(decideLink(row(), drivers(), nobody)).toEqual({ kind: "link", driverId: "d1", phoneUserId: "user_phone_1", claimedAt: NOW });
  });
  it("does nothing when the driver already has that phone", () => {
    expect(decideLink(row(), drivers("user_phone_1"), nobody)).toEqual({ kind: "ignore" });
  });
  it("unlinks an ended row only while the driver still holds that phone, and says who ended it", () => {
    expect(decideLink(row({ revoked_at: NOW.toISOString(), ended_by: "driver" }), drivers("user_phone_1"), nobody)).toMatchObject({ kind: "unlink", endedBy: "driver" });
    expect(decideLink(row({ revoked_at: NOW.toISOString() }), drivers("user_other"), nobody)).toEqual({ kind: "ignore" });
  });
  it("flags a phone another driver in the fleet holds, and never moves it", () => {
    expect(decideLink(row({ claimed_by: "user_phone_2" }), drivers(), (p) => (p === "user_phone_2" ? "d2" : null))).toMatchObject({ kind: "flag", driverId: "d1" });
  });
  it("ignores unclaimed rows, unknown drivers and a claimed_by that is not a plain id", () => {
    expect(decideLink(row({ claimed_by: null }), drivers(), nobody).kind).toBe("ignore");
    expect(decideLink(row({ desk_driver_id: "ghost" }), drivers(), nobody).kind).toBe("ignore");
    expect(decideLink(row({ claimed_by: "x&y=z" }), drivers(), nobody).kind).toBe("ignore");
  });
});

describe("what the driver's page says", () => {
  const later = new Date(NOW.getTime() + 3600_000);
  it("linked, waiting, ran out, or nothing", () => {
    expect(linkStateOf({ phoneUserId: "u", latest: null, now: NOW })).toEqual({ kind: "linked", since: null });
    expect(linkStateOf({ phoneUserId: null, latest: { expiresAt: later, claimedAt: null, revokedAt: null }, now: NOW })).toEqual({ kind: "pending", expiresAt: later });
    expect(linkStateOf({ phoneUserId: null, latest: { expiresAt: NOW, claimedAt: null, revokedAt: null }, now: NOW })).toEqual({ kind: "expired" });
    expect(linkStateOf({ phoneUserId: null, latest: { expiresAt: later, claimedAt: null, revokedAt: NOW }, now: NOW })).toEqual({ kind: "none" });
    expect(linkStateOf({ phoneUserId: null, latest: null, now: NOW })).toEqual({ kind: "none" });
  });
});

describe("the bridge table, in memory (claim rules as bridge.claim_driver_link)", () => {
  it("a code works once, for one phone, until it runs out or a new one replaces it", async () => {
    const t = memoryTransport();
    const h = hashInviteCode("ABCDEFGHJK");
    await t.insertLink(newLinkRow({ orgId: "o", driverId: "d1", carrierName: "C", role: "company", codeHash: h, expiresAt: inviteExpiresAt(NOW) }));
    expect(t.claim(h, "user_a", NOW)).toBe("ok");
    expect(t.claim(h, "user_a", NOW)).toBe("ok"); // a retried tap
    expect(t.claim(h, "user_b", NOW)).toBe("link_used");
    expect(await t.claimedLinks("o", 10)).toHaveLength(1);

    const h2 = hashInviteCode("BBBBBBBBBB");
    await t.insertLink(newLinkRow({ orgId: "o", driverId: "d2", carrierName: "C", role: "company", codeHash: h2, expiresAt: inviteExpiresAt(NOW) }));
    await t.revokeUnclaimedLinks("o", "d2", NOW);
    expect(t.claim(h2, "user_c", NOW)).toBe("link_invalid");

    const h3 = hashInviteCode("CCCCCCCCCC");
    await t.insertLink(newLinkRow({ orgId: "o", driverId: "d3", carrierName: "C", role: "company", codeHash: h3, expiresAt: NOW }));
    expect(t.claim(h3, "user_d", NOW)).toBe("link_invalid");
  });

  it("ending a link from the desk withdraws it", async () => {
    const t = memoryTransport();
    const h = hashInviteCode("ABCDEFGHJK");
    await t.insertLink(newLinkRow({ orgId: "o", driverId: "d1", carrierName: "C", role: "company", codeHash: h, expiresAt: inviteExpiresAt(NOW) }));
    t.claim(h, "user_a", NOW);
    await t.endLink("o", "d1", NOW);
    const [l] = await t.claimedLinks("o", 10);
    expect(l).toMatchObject({ revoked_at: NOW.toISOString(), ended_by: "desk" });
  });
});

describe("the real transport's link calls", () => {
  const cfg = { url: "https://x.supabase.co", key: "service-key-secret" };
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("writes the link row on the bridge schema with the service key", async () => {
    const f = ok([{ id: "link-1" }]);
    const t = supabaseTransport(cfg, f as unknown as typeof fetch);
    expect(await t.insertLink({ org_id: "o" })).toEqual({ id: "link-1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.supabase.co/rest/v1/driver_links");
    expect((init.headers as Record<string, string>)["Content-Profile"]).toBe("bridge");
  });

  it("reads claimed links with the columns the desk needs and never the hash", async () => {
    const f = ok([]);
    const t = supabaseTransport(cfg, f as unknown as typeof fetch);
    await t.claimedLinks("desk_ws1", 50);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toContain("org_id=eq.desk_ws1");
    expect(url).toContain("claimed_by=not.is.null");
    expect(url).not.toContain("code_hash");
  });

  it("withdraws only unclaimed codes when a new one is made", async () => {
    const f = ok([]);
    const t = supabaseTransport(cfg, f as unknown as typeof fetch);
    await t.revokeUnclaimedLinks("o", "d1", NOW);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("claimed_by=is.null");
    expect(init.method).toBe("PATCH");
  });

  it("refuses an id that is not plain, and a failure never carries the key", async () => {
    const t = supabaseTransport(cfg, ok([]) as unknown as typeof fetch);
    await expect(t.claimedLinks("o&x=y", 10)).rejects.toBeInstanceOf(BridgeTransportError);
    const down = supabaseTransport(cfg, (async () => new Response("boom service-key-secret", { status: 500 })) as unknown as typeof fetch);
    const e = await down.insertLink({}).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain("service-key-secret");
  });
});
