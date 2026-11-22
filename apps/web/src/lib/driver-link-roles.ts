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

/** The role a new code suggests: an employee is a company driver, a contractor an owner-operator leased on; the dispatcher can change it. */
export function suggestedLinkRole(payrollWorkerType: string | null | undefined): LinkRole {
  return payrollWorkerType === "contractor" ? "owner_op_leased" : "company";
}
