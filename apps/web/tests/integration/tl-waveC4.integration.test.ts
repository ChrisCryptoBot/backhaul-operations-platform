import { afterAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { listAudit, recordAudit } from "@/server/tl/audit";
import { buildExport } from "@/server/tl/exports";

/** Needs a seeded database. Writes its own audit events (far in the past, with a unique word) and removes them afterwards. */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WORD = "zq-c4-audit";

describe.skipIf(!run)("audit filters and CSV", () => {
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { summary: { contains: WORD } } });
  });

  test("search, area and the From and To days combine, and the CSV follows the same filters", async () => {
    // Three events on three Dallas days in 2019: 11:30 pm on the 3rd (04 Jan 05:30Z, still the 3rd in Dallas), noon on the 4th, noon on the 5th.
    await recordAudit({ entity: "customer", action: "customer_added", summary: `${WORD} one`, at: new Date("2019-03-04T05:30:00Z") });
    await recordAudit({ entity: "customer", action: "customer_changed", summary: `${WORD} two`, reason: "typo", at: new Date("2019-03-04T18:00:00Z") });
    await recordAudit({ entity: "settings", action: "company_changed", summary: `${WORD} three`, at: new Date("2019-03-05T18:00:00Z") });

    const all = await listAudit({ q: WORD });
    expect(all.total).toBe(3);

    // The 3rd in Dallas holds the first event (UTC says the 4th).
    expect((await listAudit({ q: WORD, from: "2019-03-03", to: "2019-03-03" })).rows.map((r) => r.summary)).toEqual([`${WORD} one`]);
    // Both ends are included, newest first.
    expect((await listAudit({ q: WORD, from: "2019-03-04", to: "2019-03-05" })).rows.map((r) => r.summary)).toEqual([`${WORD} three`, `${WORD} two`]);
    // Area narrows it further.
    expect((await listAudit({ q: WORD, group: "customers", from: "2019-03-03", to: "2019-03-05" })).total).toBe(2);
    // An open end, and a swapped pair, still find them.
    expect((await listAudit({ q: WORD, from: "2019-03-05" })).total).toBe(1);
    expect((await listAudit({ q: WORD, from: "2019-03-05", to: "2019-03-03" })).total).toBe(3);

    const csv = (await buildExport("audit", { q: WORD, group: "customers", from: "2019-03-03", to: "2019-03-05" }))!;
    const lines = csv.csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("When (Central),Load,What,Detail,Reason,By");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Customer changed");
    expect(lines[1]).toContain("typo");
    expect(lines[1]).toContain("2019-03-04 12:00");
    expect(lines[2]).toContain("Customer added");
    expect(csv.filename).toMatch(/^truelane-desk-audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
