import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CONTACT } from "../src/lib/contact";
import { EMPTY_REQUEST, ENTERPRISE_TRUCKS, checkRequest, kindFor, parseTrucks, readRequest } from "../src/lib/signup";

const ok = { ...EMPTY_REQUEST, name: "Pat Driver", company: "Pat Freight", email: "pat@example.com", trucks: "12" };

describe("who signs themselves up and who gets a person", () => {
  it("draws the line at 50 trucks: 49 is self-serve, 50 and 100 are enterprise", () => {
    expect(ENTERPRISE_TRUCKS).toBe(50);
    expect(kindFor(1)).toBe("self_serve");
    expect(kindFor(49)).toBe("self_serve");
    expect(kindFor(50)).toBe("enterprise");
    expect(kindFor(100)).toBe("enterprise");
    expect(kindFor(1500)).toBe("enterprise");
  });

  it("reads a truck count the way a person types it, and refuses what is not one", () => {
    expect(parseTrucks("12")).toBe(12);
    expect(parseTrucks(" 1,500 ")).toBe(1500);
    expect(parseTrucks(7)).toBe(7);
    for (const bad of ["", "0", "-3", "4.5", "twelve", "1e3", "12 trucks", "9999999", null, undefined, {}, 0, 2.5]) expect(parseTrucks(bad), String(bad)).toBeNull();
  });
});

describe("a request", () => {
  it("passes with the four things an account needs", () => {
    expect(checkRequest(ok, "self_serve")).toEqual({});
  });
  it("says what is missing, field by field", () => {
    const e = checkRequest({ ...EMPTY_REQUEST }, "self_serve");
    expect(Object.keys(e).sort()).toEqual(["company", "email", "name", "trucks"]);
  });
  it("rejects a bad email and a bad truck count", () => {
    expect(checkRequest({ ...ok, email: "not-an-email" }, "self_serve").email).toBeTruthy();
    expect(checkRequest({ ...ok, trucks: "lots" }, "self_serve").trucks).toBeTruthy();
  });
  it("asks an enterprise request for a number or a time, since a person will phone", () => {
    const big = { ...ok, trucks: "80" };
    expect(checkRequest(big, "enterprise").phone).toBeTruthy();
    expect(checkRequest({ ...big, phone: "555-0100" }, "enterprise")).toEqual({});
    expect(checkRequest({ ...big, bestTime: "Weekdays after 2 pm" }, "enterprise")).toEqual({});
    // a self-serve request never needs a phone
    expect(checkRequest(ok, "self_serve").phone).toBeUndefined();
  });
  it("keeps fields to a sensible length", () => {
    expect(checkRequest({ ...ok, name: "x".repeat(500) }, "self_serve").name).toBeTruthy();
    expect(checkRequest({ ...ok, note: "x".repeat(2000) }, "enterprise").note).toBeTruthy();
  });
  it("reads a form as trimmed text and ignores anything that is not text", () => {
    const f = new FormData();
    f.set("name", "  Pat  ");
    f.set("email", "pat@example.com");
    f.set("company", new Blob(["x"]) as unknown as string); // a file in a text field counts as empty
    const v = readRequest(f);
    expect(v.name).toBe("Pat");
    expect(v.company).toBe("");
    expect(v.trucks).toBe("");
  });
});

describe("the contact is real", () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  it("has an email and a booking link, and no invented phone number", () => {
    expect(CONTACT.email).toMatch(/@/);
    expect(CONTACT.bookingUrl).toMatch(/^https:\/\//);
    // the placeholder number the marketing site carries must never be shown as if it were real
    expect(CONTACT.phone === null || !/555[-\s.]?01\d\d/.test(CONTACT.phone)).toBe(true);
  });
  it("the contact card shows a phone line only when one is set, and promises no hours of its own", () => {
    const card = src("src/components/desk/public/contact-card.tsx");
    expect(card).toContain("CONTACT.phone ?");
    expect(card).toContain("CONTACT.hours ?");
    expect(card).not.toMatch(/24\s*\/\s*7|around the clock|24 hours/i);
  });
  it("the server decides the kind from the truck count, never from the form", () => {
    const server = src("src/server/tl/signup.ts");
    expect(server).toContain("kindFor(trucks ?? 1)");
    const actions = src("src/app/(public)/actions.ts");
    expect(actions).not.toMatch(/formData\.get\(["']kind["']\)/);
  });
  it("a large fleet is never given a self-serve account: the enterprise page makes no workspace", () => {
    const server = src("src/server/tl/signup.ts");
    expect(server).not.toMatch(/workspace\.(create|upsert)/);
  });
});

describe("signing out", () => {
  it("the sidebar always has a Sign out button that goes to sign-in", () => {
    const shell = fs.readFileSync(path.join(__dirname, "..", "src/components/desk/desk-shell.tsx"), "utf8");
    expect(shell).toContain("Sign out");
    expect(shell).toContain('router.push("/sign-in")');
    expect(shell).toContain('data-tip={collapsed ? "Sign out" : undefined}'); // named in the folded rail too
  });
});
