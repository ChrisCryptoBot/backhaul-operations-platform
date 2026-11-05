import { describe, expect, it } from "vitest";
import { CAPABILITIES, GRANTS, ROLES, ROLE_LABEL, can, canAny, cleanGrants, whoCan, type Capability, type Role } from "../src/lib/roles";

/**
 * Who may do what, as one table. The desk has five roles that are not in a line (accounting is not "above" a dispatcher), so each role is a list of named capabilities; an admin can
 * give a dispatcher the billing office's work as a grant, and nobody can be given the capabilities that destroy money or run the desk.
 */
const TABLE: Record<Capability, Record<Role, boolean>> = {
  read: { viewer: true, dispatcher: true, driver_manager: true, accounting: true, admin: true },
  quote: { viewer: false, dispatcher: true, driver_manager: false, accounting: false, admin: true },
  dispatch: { viewer: false, dispatcher: true, driver_manager: false, accounting: false, admin: true },
  roster: { viewer: false, dispatcher: false, driver_manager: true, accounting: false, admin: true },
  documents: { viewer: false, dispatcher: true, driver_manager: true, accounting: true, admin: true },
  figures: { viewer: false, dispatcher: true, driver_manager: false, accounting: true, admin: true },
  billing_details: { viewer: false, dispatcher: false, driver_manager: false, accounting: true, admin: true },
  bill: { viewer: false, dispatcher: false, driver_manager: false, accounting: true, admin: true },
  payout: { viewer: false, dispatcher: false, driver_manager: false, accounting: true, admin: true },
  writeoff: { viewer: false, dispatcher: false, driver_manager: false, accounting: false, admin: true },
  admin: { viewer: false, dispatcher: false, driver_manager: false, accounting: false, admin: true }
};

describe("the role matrix", () => {
  it("names five roles, owner no longer one of them", () => {
    expect([...ROLES]).toEqual(["viewer", "dispatcher", "driver_manager", "accounting", "admin"]);
    expect(ROLE_LABEL.admin).toBe("Admin");
  });

  it.each(CAPABILITIES.flatMap((c) => ROLES.map((r) => [c, r] as const)))("%s for a %s", (capability, role) => {
    expect(can(role, [], capability)).toBe(TABLE[capability][role]);
  });

  it("gives an admin everything and a viewer only reading", () => {
    for (const c of CAPABILITIES) expect(can("admin", [], c)).toBe(true);
    expect(CAPABILITIES.filter((c) => can("viewer", [], c))).toEqual(["read"]);
  });

  it("a driver manager sets who works when and where, and can neither dispatch nor bill; nobody else can roster", () => {
    expect(CAPABILITIES.filter((c) => can("driver_manager", [], c))).toEqual(["read", "roster", "documents"]);
    expect(ROLES.filter((r) => can(r, [], "roster"))).toEqual(["driver_manager", "admin"]);
    expect(can("dispatcher", ["bill"], "roster")).toBe(false);
    expect(whoCan("roster")).toBe("Driver manager or Admin");
  });

  it("keeps accounting out of dispatching, and a dispatcher out of billing", () => {
    expect(can("accounting", [], "dispatch")).toBe(false);
    expect(can("accounting", [], "quote")).toBe(false);
    expect(can("dispatcher", [], "bill")).toBe(false);
    expect(can("dispatcher", [], "payout")).toBe(false);
  });
});

describe("grants", () => {
  it("let a dispatcher do the billing office's work, and nothing that destroys money or runs the desk", () => {
    expect([...GRANTS]).toEqual(["bill"]);
    for (const c of ["billing_details", "bill", "payout"] as const) expect(can("dispatcher", ["bill"], c)).toBe(true);
    for (const c of ["writeoff", "admin"] as const) expect(can("dispatcher", ["bill"], c)).toBe(false);
    // The dispatcher's own work is untouched.
    expect(can("dispatcher", ["bill"], "dispatch")).toBe(true);
  });

  it("do nothing for any other role (they either have the work or may not have it)", () => {
    expect(can("viewer", ["bill"], "bill")).toBe(false);
    expect(can("accounting", ["bill"], "writeoff")).toBe(false);
  });

  it("ignore anything unknown, so an edited row cannot widen what a person may do", () => {
    expect(cleanGrants(["bill", "admin", 7, "bill"])).toEqual(["bill"]);
    expect(can("dispatcher", ["admin", "writeoff"], "writeoff")).toBe(false);
    expect(cleanGrants(null)).toEqual([]);
    expect(cleanGrants("bill")).toEqual([]);
  });
});

describe("either of two capabilities", () => {
  it("is enough: a screen two offices share", () => {
    expect(canAny("accounting", [], ["dispatch", "bill"])).toBe(true);
    expect(canAny("dispatcher", [], ["dispatch", "bill"])).toBe(true);
    expect(canAny("viewer", [], ["dispatch", "bill"])).toBe(false);
    expect(canAny("viewer", [], [])).toBe(false);
  });
});

describe("saying who can", () => {
  it("lists the roles in words", () => {
    expect(whoCan("writeoff")).toBe("Admin");
    expect(whoCan("bill")).toBe("Accounting or Admin");
    expect(whoCan("dispatch")).toBe("Dispatcher or Admin");
    expect(whoCan("figures")).toBe("Dispatcher, Accounting or Admin");
  });
});
