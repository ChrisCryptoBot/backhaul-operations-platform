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

/** The role a new code suggests: an employee is a company driver, a contractor an owner-operator leased on; the dispatcher can change it. */
export function suggestedLinkRole(payrollWorkerType: string | null | undefined): LinkRole {
  return payrollWorkerType === "contractor" ? "owner_op_leased" : "company";
}
