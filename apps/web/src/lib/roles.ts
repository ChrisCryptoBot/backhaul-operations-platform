/**
 * The three roles of a person on a desk. A viewer can look at everything and change nothing; a dispatcher does the work (quote, dispatch, bill, pay); an owner also changes the
 * company, the rules, the connections and who is on the desk. Pure.
 */
export const ROLES = ["viewer", "dispatcher", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = { viewer: "Viewer", dispatcher: "Dispatcher", owner: "Owner" };
export const ROLE_NOTE: Record<Role, string> = { viewer: "Can look at everything, changes nothing.", dispatcher: "Quotes, dispatches, bills and pays drivers.", owner: "Also changes the company, rules, connections and who is on the desk." };

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

/** Whether `role` may do what `min` is needed for: an owner may do anything a dispatcher may, and a dispatcher anything a viewer may. */
export const roleAtLeast = (role: Role, min: Role): boolean => ROLES.indexOf(role) >= ROLES.indexOf(min);
