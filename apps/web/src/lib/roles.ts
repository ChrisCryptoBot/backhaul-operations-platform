/**
 * The five roles of a person on a desk, and what each may do. A viewer looks at everything and changes nothing. A dispatcher runs the freight: quotes and negotiates, assigns and sends,
 * enters the trip, collects documents. Accounting is the back office: it invoices, records payments, chases, makes driver statements and sends payroll, and changes a load's billing details
 * only. A driver manager looks after the people, not the freight: who works when (shifts and time off), driver codes and each driver's home terminal; they look at everything and cannot dispatch or bill. An admin does everything and also changes the company, the rules, the connections and who is on the desk, and is the only one who writes off a shortfall or voids a finished driver
 * statement. Accounting is not "above" a dispatcher, so what a role may do is a list of named capabilities, not a rank. An admin can also give a dispatcher the billing capabilities as a
 * per-person grant ("Can also bill"). Pure.
 */
export const ROLES = ["viewer", "dispatcher", "driver_manager", "accounting", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "read", // look at everything, export
  "quote", // negotiate and book in Quote a load
  "dispatch", // run loads: assign, send, cancel, TONU, reschedule, the pickup and the delivery, the fleet, the rate-confirmation intake
  "roster", // who works when and from where: shifts and time off, driver codes, each driver's home terminal
  "documents", // upload and remove rate confirmations and proof of delivery
  "figures", // a trip's costs, miles, waits and seals
  "billing_details", // the customer, PO, bill-to contact and revenue note on a load
  "bill", // invoice, record and undo payments, void an invoice, chase, factoring steps, driver statements
  "payout", // send statements to payroll, mark a statement paid
  "writeoff", // write off a shortfall, void a finished statement
  "admin" // the company, the rules, the connections, the team and grants
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const MATRIX: Record<Role, readonly Capability[]> = {
  viewer: ["read"],
  dispatcher: ["read", "quote", "dispatch", "documents", "figures"],
  driver_manager: ["read", "roster", "documents"],
  accounting: ["read", "documents", "figures", "billing_details", "bill", "payout"],
  admin: CAPABILITIES
};

/** What an admin may give a person on top of their role. Only the billing office's work; never the capabilities that destroy money (write-off, void a statement) or run the desk. */
export const GRANTS = ["bill"] as const;
export type Grant = (typeof GRANTS)[number];
const GRANT_CAPABILITIES: Record<Grant, readonly Capability[]> = { bill: ["billing_details", "bill", "payout"] };

export const ROLE_LABEL: Record<Role, string> = { viewer: "Viewer", dispatcher: "Dispatcher", driver_manager: "Driver manager", accounting: "Accounting", admin: "Admin" };
export const ROLE_NOTE: Record<Role, string> = {
  viewer: "Can look at everything, changes nothing.",
  dispatcher: "Quotes, negotiates, dispatches and collects documents. Cannot bill or pay drivers unless an admin allows it.",
  driver_manager: "Sets who works when (shifts and time off), driver codes and each driver's home terminal. Cannot dispatch or bill.",
  accounting: "Invoices, records payments, chases, makes driver statements and sends payroll. Cannot dispatch.",
  admin: "Does everything, and also changes the company, rules, connections and who is on the desk."
};
export const GRANT_LABEL: Record<Grant, string> = { bill: "Can also bill" };

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);
export const isGrant = (v: unknown): v is Grant => typeof v === "string" && (GRANTS as readonly string[]).includes(v);
/** Grants as stored, with anything unknown dropped, so an old or edited row can never widen what a person may do. */
export const cleanGrants = (v: unknown): Grant[] => (Array.isArray(v) ? [...new Set(v.filter(isGrant))] : []);

/** Whether a person with this role and these grants has the capability. */
export function can(role: Role, grants: readonly string[] | null | undefined, capability: Capability): boolean {
  if (MATRIX[role].includes(capability)) return true;
  // A grant only ever adds to a dispatcher: it is how an admin lets a dispatcher do the billing office's work.
  return role === "dispatcher" && cleanGrants(grants).some((g) => GRANT_CAPABILITIES[g].includes(capability));
}

/** Whether they have any of these (a screen or an action that two roles share). */
export const canAny = (role: Role, grants: readonly string[] | null | undefined, capabilities: readonly Capability[]): boolean => capabilities.some((c) => can(role, grants, c));

/** The roles that can do a capability, in words, for the line that says who to ask. */
export function whoCan(capability: Capability): string {
  const roles = ROLES.filter((r) => MATRIX[r].includes(capability)).map((r) => ROLE_LABEL[r]);
  return roles.length <= 1 ? (roles[0] ?? "An admin") : `${roles.slice(0, -1).join(", ")} or ${roles[roles.length - 1]}`;
}
