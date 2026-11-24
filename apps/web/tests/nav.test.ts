import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MODULE_CODE, NAV, activeItem, railPill } from "@/lib/nav";
import { RULES } from "@/lib/alerts";

const read = (p: string) => readFileSync(join(__dirname, "..", "src", p), "utf8").replace(/\r\n/g, "\n");
const none = { needsDriver: 0, overdue: 0, readyToInvoice: 0, alertsBlock: 0, unreadMessages: 0, partnerIssues: 0 };

describe("one list of modules", () => {
  test("every module has its own two-letter code, and a page head wears the one the rail leads with", () => {
    const items = NAV.flatMap((g) => g.items);
    expect(new Set(items.map((i) => i.code)).size).toBe(items.length);
    for (const i of items) expect(i.code).toMatch(/^[A-Z]{2}$/);
    expect(MODULE_CODE).toMatchObject({ Signals: "SG", "Data health": "DH", "Why it moved": "WM", Loads: "LD" });
    expect(read("components/desk/ui.tsx")).toContain("MODULE_CODE[title]");
    // The page head is drawn on the server: the list it reads must not pull the browser shell in.
    expect(read("lib/nav.ts")).not.toContain("use client");
    expect(read("components/desk/ui.tsx")).not.toContain("./desk-shell");
  });

  test("/fleet/map is the Radar map and not also Trucks", () => {
    expect(activeItem("/fleet/map")?.code).toBe("MP");
    expect(activeItem("/fleet/abc")?.code).toBe("TK");
  });
});

describe("the rail's counts are counts of something on the page", () => {
  test("Alerts counts what blocks, the same number as the page's Block tab, and shows nothing when nothing blocks", () => {
    expect(railPill("alerts", { ...none, alertsBlock: 10 })).toEqual({ n: 10, tone: "alert" });
    expect(railPill("alerts", none)).toBeNull();
    // The shell reads open loads only. That is all a block rule reads too, so the two numbers are one number.
    for (const r of RULES.filter((x) => x.level === "block")) expect(r.appliesTo, r.code).toMatch(/open loads|waiting for/i);
  });

  test("Invoices shows what is overdue first, else what is ready to bill", () => {
    expect(railPill("invoices", { ...none, overdue: 3, readyToInvoice: 2 })).toEqual({ n: 3, tone: "alert" });
    expect(railPill("invoices", { ...none, readyToInvoice: 2 })).toEqual({ n: 2 });
  });
});
