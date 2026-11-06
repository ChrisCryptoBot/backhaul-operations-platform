import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { termsOf } from "@/lib/scope";
import { addRegion, archiveRegion, regionRows, renameRegion, setMemberScope, setTerminalRegion } from "@/server/tl/regions";
import { currentScope, limitOf } from "@/server/tl/scope";
import { listMembers } from "@/server/tl/members";
import { listBoardRows } from "@/server/tl/queries";
import { listTrucksPage } from "@/server/tl/fleet-list";
import { archiveTerminal, renameTerminal } from "@/server/tl/terminal-list";
import { getLeakLedger } from "@/server/tl/leaks";

/**
 * Regions and scope against the demo database: terminals belong to regions, a person can be limited to a region or terminals, and the limit holds on real lists (the board, the trucks, the leak ledger) however
 * the person chooses in the header. A region or terminal a person is limited to cannot be retired out from under them, an admin is never limited, and one desk never reads another's:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/scope.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "sc-w";
const OTHER = "sc-other";
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("regions and scope", () => {
  const ids = { tx: "", se: "", dallas: "", houston: "", memphis: "", tulsa: "", disp: "", admin: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "SC fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "SC other", plan: "enterprise" } });
    for (const n of ["Dallas", "Houston", "Memphis", "Tulsa"]) await prisma.terminal.create({ data: { workspaceId: W, name: n } });
    for (const [n, t] of [["SC Dallas Truck", "Dallas"], ["SC Houston Truck", "Houston"], ["SC Memphis Truck", "Memphis"], ["SC Tulsa Truck", "Tulsa"]] as const) {
      const v = await prisma.vehicle.create({ data: { workspaceId: W, name: n, terminal: t } });
      await prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: `L-${t}`, status: "accepted", quotedRevenue: 900, scheduledDate: ago(-1) } });
      await prisma.load.create({ data: { workspaceId: W, vehicleId: v.id, loadNumber: `D-${t}`, status: "completed", quotedRevenue: 1000, actualRevenue: 1000, loadedMiles: 500, completedAt: ago(2), snapshotBaseFloorRpm: 1, pickupDeadheadMiles: t === "Memphis" ? 100 : 10 } });
    }
    // An unplaced load: nobody's truck or driver, so everyone who can assign it sees it.
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "L-NOWHERE", status: "draft", quotedRevenue: 500, scheduledDate: ago(-2) } });
    ids.disp = (await prisma.member.create({ data: { workspaceId: W, email: "disp@sc.test", name: "SC Dispatcher", role: "dispatcher" } })).id;
    ids.admin = (await prisma.member.create({ data: { workspaceId: W, email: "admin@sc.test", name: "SC Admin", role: "admin" } })).id;
    await prisma.terminal.create({ data: { workspaceId: OTHER, name: "Dallas" } });
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("a region is made, refused when it repeats, renamed, and terminals are put in it and taken out", async () => {
    const tx = await addRegion({ name: "  Texas ", note: "The home state" }, NOW, W);
    expect(tx).toMatchObject({ ok: true });
    ids.tx = (tx as { id: string }).id;
    ids.se = ((await addRegion({ name: "Southeast" }, NOW, W)) as { id: string }).id;
    expect(await addRegion({ name: "texas" }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/already a region/) });
    expect(await addRegion({ name: "   " }, NOW, W)).toMatchObject({ ok: false });
    const terms = await prisma.terminal.findMany({ where: { workspaceId: W } });
    const id = (n: string) => terms.find((t) => t.name === n)!.id;
    expect(await setTerminalRegion(id("Dallas"), ids.tx, NOW, W)).toEqual({ ok: true });
    expect(await setTerminalRegion(id("Houston"), ids.tx, NOW, W)).toEqual({ ok: true });
    expect(await setTerminalRegion(id("Memphis"), ids.se, NOW, W)).toEqual({ ok: true });
    expect(await setTerminalRegion(id("Memphis"), "nope", NOW, W)).toMatchObject({ ok: false });
    expect(await setTerminalRegion(id("Dallas"), ids.tx, NOW, OTHER)).toMatchObject({ ok: false }); // another desk's terminal id
    const rows = await regionRows(W);
    expect(rows.regions.map((r) => [r.name, r.terminals.map((t) => t.name)])).toEqual([["Southeast", ["Memphis"]], ["Texas", ["Dallas", "Houston"]]]);
    expect(rows.unassigned.map((t) => t.name)).toEqual(["Tulsa"]);
    expect(await renameRegion(ids.tx, "Lone Star", NOW, W)).toEqual({ ok: true, id: ids.tx });
    expect(await renameRegion(ids.se, "lone star", NOW, W)).toMatchObject({ ok: false });
    expect(await renameRegion(ids.tx, "Texas", NOW, W)).toEqual({ ok: true, id: ids.tx });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: { in: ["region_added", "region_renamed", "terminal_region_set"] } } })).toBe(2 + 3 + 2);
    ids.dallas = id("Dallas");
    ids.houston = id("Houston");
    ids.memphis = id("Memphis");
    ids.tulsa = id("Tulsa");
  });

  test("a person is limited to a region or terminals; an admin never is; one desk's region is not another's", async () => {
    expect(await setMemberScope(ids.admin, { regionIds: [ids.tx], terminals: [] }, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/admin always sees everything/) });
    expect(await setMemberScope(ids.disp, { regionIds: ["nope"], terminals: [] }, NOW, W)).toMatchObject({ ok: false });
    expect(await setMemberScope(ids.disp, { regionIds: [], terminals: ["Gone"] }, NOW, W)).toMatchObject({ ok: false });
    expect(await setMemberScope(ids.disp, { regionIds: [ids.tx], terminals: [] }, NOW, OTHER)).toMatchObject({ ok: false }); // not their desk
    expect(await setMemberScope(ids.disp, { regionIds: [ids.tx], terminals: [] }, NOW, W)).toEqual({ ok: true });
    expect(await setMemberScope(ids.disp, { regionIds: [ids.tx], terminals: [] }, NOW, W)).toEqual({ ok: true }); // no change, no second audit line
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "member_scope_changed" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toBe("SC Dispatcher can see: Texas region");
    const me = (await listMembers(W)).find((m) => m.id === ids.disp)!;
    expect(me.scope).toEqual({ regionIds: [ids.tx], terminals: [] });
    expect((await listMembers(W)).find((m) => m.id === ids.admin)!.scope).toEqual({ regionIds: [], terminals: [] });
  });

  test("the limit holds on real lists, whatever the person chooses in the header", async () => {
    const limit = limitOf((await listMembers(W)).find((m) => m.id === ids.disp)!.scope.regionIds.map((regionId) => ({ regionId, terminal: null })));
    // They choose Memphis: outside what they may see, so they get all of Texas, never Memphis.
    const s = await currentScope(W, { choice: { kind: "terminals", names: ["Memphis"] }, limit });
    expect(s).toMatchObject({ names: ["Dallas", "Houston"], label: "Texas region", limited: true });
    const board = (await listBoardRows(W, "open", termsOf(s))).map((r) => r.loadNumber);
    expect(board.sort()).toEqual(["L-Dallas", "L-Houston", "L-NOWHERE"].sort()); // Texas and the unplaced one; no Memphis, no Tulsa
    const trucks = (await listTrucksPage({ terminal: termsOf(s) }, W)).rows.map((t) => t.name);
    expect(trucks.sort()).toEqual(["SC Dallas Truck", "SC Houston Truck"]);
    // Narrowing to one terminal inside the limit works.
    const one = await currentScope(W, { choice: { kind: "terminals", names: ["Houston"] }, limit });
    expect((await listTrucksPage({ terminal: termsOf(one) }, W)).rows.map((t) => t.name)).toEqual(["SC Houston Truck"]);
    // Not limited sees all four.
    const all = await currentScope(W, { choice: { kind: "all" }, limit: { kind: "all" } });
    expect((await listTrucksPage({ terminal: termsOf(all) }, W)).rows).toHaveLength(4);
    // The ledger takes the same scope: Memphis's empty miles are not in a Texas ledger.
    const texas = await getLeakLedger({ period: "4w", compare: false, terminals: s.names }, NOW, W);
    const everything = await getLeakLedger({ period: "4w", compare: false, terminals: null }, NOW, W);
    expect(texas.current.lines.find((l) => l.key === "empty_miles")!.dollars).toBe(20); // 10 + 10 empty miles at $1
    expect(everything.current.lines.find((l) => l.key === "empty_miles")!.dollars).toBe(130); // plus Memphis's 100 and Tulsa's 10
  });

  test("a region or a terminal a person is limited to cannot be retired out from under them", async () => {
    expect(await archiveRegion(ids.tx, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/1 person is limited to Texas/) });
    expect(await setMemberScope(ids.disp, { regionIds: [], terminals: ["Memphis"] }, NOW, W)).toEqual({ ok: true });
    expect(await archiveTerminal(ids.memphis, NOW, W)).toMatchObject({ ok: false, error: expect.stringMatching(/limited to Memphis/) });
    // A rename keeps the person's limit pointing at the same terminal.
    expect(await renameTerminal(ids.memphis, "Memphis TN", NOW, W)).toEqual({ ok: true, id: ids.memphis });
    expect((await listMembers(W)).find((m) => m.id === ids.disp)!.scope).toEqual({ regionIds: [], terminals: ["Memphis TN"] });
    expect(await setMemberScope(ids.disp, { regionIds: [], terminals: [] }, NOW, W)).toEqual({ ok: true }); // not limited again
    expect((await archiveRegion(ids.se, NOW, W)).ok).toBe(true); // nobody is limited to Southeast: retired, its terminal unassigned
    expect((await prisma.terminal.findUniqueOrThrow({ where: { id: ids.memphis } })).regionId).toBeNull();
    expect((await regionRows(W)).regions.map((r) => r.name)).toEqual(["Texas"]);
  });

  test("promoting a limited person to admin clears their limit", async () => {
    await setMemberScope(ids.disp, { regionIds: [ids.tx], terminals: [] }, NOW, W);
    const { setMemberRole } = await import("@/server/tl/members");
    expect(await setMemberRole(ids.disp, "admin", NOW, W)).toMatchObject({ ok: true });
    expect(await prisma.memberScope.count({ where: { memberId: ids.disp } })).toBe(0);
  });

  test("a scope outside a request is everything, and a signed-out stand-in sees nothing", async () => {
    expect((await currentScope(W)).names).toBeNull();
    const none = await currentScope(W, { limit: { kind: "some", regionIds: [], terminals: [] } });
    expect(none).toMatchObject({ names: [], label: "No terminals" });
    expect(await listBoardRows(W, "open", termsOf(none))).toHaveLength(1); // only the unplaced load
  });
});
