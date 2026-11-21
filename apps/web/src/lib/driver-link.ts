/**
 * The driver link's identity half, pure (Phase 2 step 1; docs/DRIVER_LINK_DESIGN.md section 3a). A dispatcher makes a single-use, expiring invite code for one driver; the driver types it on
 * their TrueLane phone, which claims it on the bridge as themselves; the desk's next pull reads the claim and fills that driver's phone account. No database, no network, no clock but the one
 * passed in.
 *
 * The desk and the phone use separate Clerk instances, so the ids on the bridge are the PHONE's: `claimed_by` is the phone's Clerk user id, and the tenant key (`org_id`) is the desk's own
 * (`Workspace.bridgeOrgId`, or `desk_<workspace id>` for a fleet that has never linked), not a Clerk Organization of either instance. The driver-side bridge policies key on the phone's
 * user id alone, so this is all they need.
 */
import { createHash, randomInt } from "node:crypto";

/** No 0/O, 1/I/L: a code read aloud over the phone or copied off a screen cannot be mistyped into another one. 31 letters, 10 of them: about 49 bits. */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_LENGTH = 10;
/** How long a code can be claimed. A claimed link lasts until either side ends it. */
export const INVITE_DAYS = 7;

export type LinkRole = "company" | "lease_purchase" | "owner_op_leased";
export const LINK_ROLES: readonly { value: LinkRole; label: string }[] = [
  { value: "company", label: "Company driver" },
  { value: "lease_purchase", label: "Lease-purchase" },
  { value: "owner_op_leased", label: "Owner-operator, leased on" }
];
export const isLinkRole = (v: unknown): v is LinkRole => LINK_ROLES.some((r) => r.value === v);

/** The role a new code suggests: an employee is a company driver, a contractor an owner-operator leased on; the dispatcher can change it. */
export function suggestedLinkRole(payrollWorkerType: string | null | undefined): LinkRole {
  return payrollWorkerType === "contractor" ? "owner_op_leased" : "company";
}

/** A new code: INVITE_LENGTH letters from INVITE_ALPHABET, from the system's secure random source. `pick` is for tests. */
export function newInviteCode(pick: (n: number) => number = randomInt): string {
  let out = "";
  for (let i = 0; i < INVITE_LENGTH; i += 1) out += INVITE_ALPHABET[pick(INVITE_ALPHABET.length)]!;
  return out;
}

/** "ABCDE-FGHJK": how a code is shown. The dash (or a space, or lower case) is ignored when it is typed back. */
export const formatInviteCode = (code: string): string => {
  const c = normalizeInviteCode(code);
  return c.length > 5 ? `${c.slice(0, 5)}-${c.slice(5)}` : c;
};

/** Letters and digits only, upper case: the one rule the desk and the bridge (bridge.invite_code_hash) both apply before hashing. */
export const normalizeInviteCode = (code: string): string => code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/** sha256 (hex) of the normalised code. Only this is stored, on the desk and on the bridge. */
export const hashInviteCode = (code: string): string => createHash("sha256").update(normalizeInviteCode(code), "utf8").digest("hex");

/** The desk's tenant key on the bridge: the workspace's own once set, else one made from its id (stable, so every code a fleet makes carries the same key). */
export const deskOrgIdFor = (ws: { id: string; bridgeOrgId: string | null }): string => ws.bridgeOrgId ?? `desk_${ws.id}`;

export const inviteExpiresAt = (now: Date): Date => new Date(now.getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000);

/** The row the desk writes on the bridge for a new code: the columns it owns, never `claimed_by` (the phone's). */
export function newLinkRow(i: { orgId: string; driverId: string; carrierName: string; role: LinkRole; codeHash: string; expiresAt: Date }) {
  return {
    org_id: i.orgId,
    desk_driver_id: i.driverId,
    carrier_name: i.carrierName.trim().slice(0, 120) || "Your carrier",
    driver_role: i.role,
    code_hash: i.codeHash,
    expires_at: i.expiresAt.toISOString()
  };
}

/** A row of `bridge.driver_links`, as the desk reads it. */
export type LinkRow = {
  id: string;
  org_id: string;
  desk_driver_id: string;
  driver_role: string;
  claimed_by: string | null;
  claimed_at: string | null;
  revoked_at: string | null;
  ended_by: string | null;
};

/** What the pull does with one link row, given the desk's drivers. */
export type LinkDecision =
  | { kind: "link"; driverId: string; phoneUserId: string; claimedAt: Date }
  | { kind: "unlink"; driverId: string; phoneUserId: string; endedBy: "desk" | "driver" }
  | { kind: "flag"; driverId: string; why: string }
  | { kind: "ignore" };

const PHONE_ID = /^[A-Za-z0-9_.:@-]{1,200}$/;

/**
 * One link row against the desk: a claimed, live row links the driver to that phone account; a claimed row that was ended clears it (only if it is still that account); a phone account another
 * driver in the fleet already holds is flagged, never moved. Unclaimed rows and rows for drivers the desk does not have are ignored.
 */
export function decideLink(row: LinkRow, drivers: ReadonlyMap<string, { phoneUserId: string | null }>, holderOf: (phoneUserId: string) => string | null): LinkDecision {
  const d = drivers.get(row.desk_driver_id);
  if (!d || !row.claimed_by || !PHONE_ID.test(row.claimed_by)) return { kind: "ignore" };
  if (row.revoked_at) {
    return d.phoneUserId === row.claimed_by ? { kind: "unlink", driverId: row.desk_driver_id, phoneUserId: row.claimed_by, endedBy: row.ended_by === "driver" ? "driver" : "desk" } : { kind: "ignore" };
  }
  if (d.phoneUserId === row.claimed_by) return { kind: "ignore" };
  const holder = holderOf(row.claimed_by);
  if (holder && holder !== row.desk_driver_id) return { kind: "flag", driverId: row.desk_driver_id, why: "That phone account is already linked to another driver in this fleet. End that link first." };
  const at = row.claimed_at ? new Date(row.claimed_at) : null;
  return { kind: "link", driverId: row.desk_driver_id, phoneUserId: row.claimed_by, claimedAt: at && !Number.isNaN(at.getTime()) ? at : new Date(0) };
}

/** What the driver's page says about the link. */
export type LinkState =
  | { kind: "linked"; since: Date | null }
  | { kind: "pending"; expiresAt: Date }
  | { kind: "expired" }
  | { kind: "none" };

export function linkStateOf(i: { phoneUserId: string | null; latest: { expiresAt: Date; claimedAt: Date | null; revokedAt: Date | null } | null; now: Date }): LinkState {
  if (i.phoneUserId) return { kind: "linked", since: i.latest?.claimedAt ?? null };
  const l = i.latest;
  if (!l || l.revokedAt || l.claimedAt) return { kind: "none" };
  return l.expiresAt.getTime() > i.now.getTime() ? { kind: "pending", expiresAt: l.expiresAt } : { kind: "expired" };
}
