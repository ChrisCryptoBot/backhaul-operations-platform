/**
 * How a linked driver works for the fleet: the part of the driver link the browser needs (the role picker on a driver's page). Kept apart from driver-link.ts, which hashes invite codes with
 * node:crypto: a client component that imported that file failed to build, so the driver page answered 500.
 */
export type LinkRole = "company" | "lease_purchase" | "owner_op_leased";
export const LINK_ROLES: readonly { value: LinkRole; label: string }[] = [
  { value: "company", label: "Company driver" },
  { value: "lease_purchase", label: "Lease-purchase" },
  { value: "owner_op_leased", label: "Owner-operator, leased on" }
];
export const isLinkRole = (v: unknown): v is LinkRole => LINK_ROLES.some((r) => r.value === v);

/**
 * What the desk asks when it makes a code (Chris 2026-11-22: two relationships, not three roles). An employee is a company driver on the phone (pay only, Dispatch first); a contractor
 * is an owner-operator the desk dispatches (their own business, Dispatch first). On the wire they are still the bridge's link roles (company, owner_op_leased), so no SQL changes;
 * a lease-purchase driver is an employee whose truck payment is a pay deduction. An older code made as lease-purchase still reads, and shows as an employee.
 */
export const LINK_RELATIONSHIPS: readonly { value: LinkRole; label: string }[] = [
  { value: "company", label: "Our employee (company driver)" },
  { value: "owner_op_leased", label: "Contractor we dispatch (owner-operator)" }
];
export const relationshipOf = (role: LinkRole): LinkRole => (role === "owner_op_leased" ? "owner_op_leased" : "company");

/**
 * What a contractor link can carry (sync plan Step 3, Chris 2026-11-22), set when the code is made. Forced dispatch: our loads are not optional, so the phone takes no other
 * dispatcher while linked. Under our authority: we bill the customer, so the phone stops asking the driver to invoice. Sponsored: we pay for their app (recorded on the link and
 * shown on their phone; nothing is billed from it yet). An employee link carries none of them (the bridge refuses one that does).
 */
export type LinkSwitches = { forcedDispatch: boolean; underAuthority: boolean; sponsored: boolean };
export const NO_SWITCHES: LinkSwitches = { forcedDispatch: false, underAuthority: false, sponsored: false };
export const LINK_SWITCHES: readonly { key: keyof LinkSwitches; label: string; hint: string }[] = [
  { key: "forcedDispatch", label: "Forced dispatch", hint: "Our loads are not optional. Their app takes no other dispatcher while linked." },
  { key: "underAuthority", label: "Runs under our authority", hint: "We bill the customer. Their app stops asking them to invoice." },
  { key: "sponsored", label: "We pay for their app", hint: "Kept on the link and shown on their phone." }
];
/** The switches a code carries: a contractor's as set, an employee's none. Anything that is not true is false. */
export function switchesFor(role: LinkRole, s: Partial<Record<keyof LinkSwitches, unknown>> | null | undefined): LinkSwitches {
  if (role !== "owner_op_leased" || !s) return { ...NO_SWITCHES };
  return { forcedDispatch: s.forcedDispatch === true, underAuthority: s.underAuthority === true, sponsored: s.sponsored === true };
}
/** "Contractor · forced dispatch · under our authority": the link's kind, in words, for the driver's page. */
export function linkKindText(role: LinkRole, s: LinkSwitches): string {
  if (role !== "owner_op_leased") return "Our employee";
  const parts = ["Contractor we dispatch", s.forcedDispatch ? "forced dispatch" : null, s.underAuthority ? "under our authority" : null, s.sponsored ? "we pay for their app" : null];
  return parts.filter(Boolean).join(" · ");
}

/** The role a new code suggests: an employee is a company driver, a contractor an owner-operator leased on; the dispatcher can change it. */
export function suggestedLinkRole(payrollWorkerType: string | null | undefined): LinkRole {
  return payrollWorkerType === "contractor" ? "owner_op_leased" : "company";
}
