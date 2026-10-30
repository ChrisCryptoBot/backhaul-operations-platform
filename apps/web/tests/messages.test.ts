import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { CANNED, MAX_BODY, SAVED_ONLY_NOTE, cleanBody, dayLabel, groupByDay, snippet, stamp } from "../src/lib/messages";

const at = (iso: string) => new Date(iso);

describe("cleanBody", () => {
  it("trims, and refuses an empty message or anything that is not text", () => {
    expect(cleanBody("  Call me.  ")).toEqual({ ok: true, body: "Call me." });
    expect(cleanBody("   \n ")).toMatchObject({ ok: false });
    expect(cleanBody(null)).toMatchObject({ ok: false });
    expect(cleanBody(42)).toMatchObject({ ok: false });
  });
  it("flattens runs of blank lines and normalises line endings", () => {
    expect(cleanBody("a\r\n\r\n\r\n\r\nb")).toEqual({ ok: true, body: "a\n\nb" });
  });
  it("holds exactly the limit and says by how much it is over", () => {
    expect(cleanBody("x".repeat(MAX_BODY))).toMatchObject({ ok: true });
    const over = cleanBody("x".repeat(MAX_BODY + 7));
    expect(over).toEqual({ ok: false, error: `That is 7 characters over the ${MAX_BODY} limit.` });
  });
});

describe("snippet", () => {
  it("keeps a short message whole and cuts a long one at a word with an ellipsis", () => {
    expect(snippet("Leaving now")).toBe("Leaving now");
    const cut = snippet("The pickup time moved so please check the load and tell me when you are rolling out", 40);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(cut).not.toMatch(/\s…$/);
  });
  it("puts a multi-line message on one line", () => {
    expect(snippet("one\n\n two")).toBe("one two");
  });
});

describe("days, by the desk's own (Central) calendar", () => {
  const now = at("2026-10-30T18:00:00Z"); // 1 pm Central, Oct 30
  it("names today, yesterday and an older date", () => {
    expect(dayLabel(at("2026-10-30T14:00:00Z"), now)).toBe("Today");
    expect(dayLabel(at("2026-10-29T20:00:00Z"), now)).toBe("Yesterday");
    expect(dayLabel(at("2026-10-20T20:00:00Z"), now)).toBe("Oct 20");
  });
  it("does not move a late-evening message to the next day (it is the Central date that counts, not UTC)", () => {
    // 11:30 pm Central on Oct 29 is already Oct 30 in UTC.
    expect(dayLabel(at("2026-10-30T04:30:00Z"), now)).toBe("Yesterday");
  });
  it("stamps the time for today and the day for earlier", () => {
    expect(stamp(at("2026-10-30T14:05:00Z"), now)).toBe("9:05 AM");
    expect(stamp(at("2026-10-29T20:00:00Z"), now)).toBe("Yesterday");
  });
  it("groups in the order sent under one heading per day", () => {
    const msgs = [
      { id: "c", sentAt: at("2026-10-30T15:00:00Z") },
      { id: "a", sentAt: at("2026-10-29T15:00:00Z") },
      { id: "b", sentAt: at("2026-10-29T16:00:00Z") }
    ];
    const g = groupByDay(msgs, now);
    expect(g.map((x) => x.day)).toEqual(["Yesterday", "Today"]);
    expect(g[0]!.items.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("the desk never claims a message reached a phone", () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  it("says plainly that nothing carries a message to a driver's phone yet", () => {
    expect(SAVED_ONLY_NOTE).toMatch(/Nothing carries them to a driver's phone yet/);
  });
  it("the server never sets deliveredAt, and the page labels an undelivered message as saved on the desk", () => {
    expect(src("src/server/tl/messages.ts")).not.toMatch(/deliveredAt\s*:\s*(new Date|now)/);
    expect(src("src/app/(desk)/messages/page.tsx")).toContain("SAVED_ONLY");
  });
  it("has ready-written lines, each inside the limit", () => {
    expect(CANNED.length).toBeGreaterThan(0);
    for (const c of CANNED) expect(c.length).toBeLessThanOrEqual(MAX_BODY);
  });
});
