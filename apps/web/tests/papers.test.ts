import { describe, expect, test } from "vitest";
import { papersCell } from "@/lib/papers";

const NOW = new Date("2026-11-23T18:00:00Z");
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("a unit's papers in one cell", () => {
  test("the one that runs out first speaks for them, and the title says them all", () => {
    const c = papersCell([{ name: "CDL", expires: d("2027-05-30") }, { name: "Medical", expires: d("2027-04-10") }], NOW);
    expect(c.tone).toBe("ok");
    expect(c.text).toBe("Medical to Apr 10");
    expect(c.title).toBe("CDL to May 30 · Medical to Apr 10");
  });
  test("inside thirty days is a warning, past is lapsed", () => {
    expect(papersCell([{ name: "CDL", expires: d("2026-12-01") }], NOW)).toMatchObject({ tone: "warn", text: "CDL to Dec 1" });
    expect(papersCell([{ name: "CDL", expires: d("2027-06-01") }, { name: "Medical", expires: d("2026-11-01") }], NOW)).toMatchObject({ tone: "bad", text: "Medical lapsed Nov 1" });
  });
  test("a paper nobody entered is said as that, never as a question mark or a dash, and never hides a lapsed one", () => {
    expect(papersCell([{ name: "CDL", expires: null }, { name: "Medical", expires: null }], NOW)).toMatchObject({ tone: "muted", text: "Not on file" });
    expect(papersCell([{ name: "CDL", expires: d("2027-06-01") }, { name: "Medical", expires: null }], NOW)).toMatchObject({ tone: "warn", text: "Medical not on file" });
    expect(papersCell([{ name: "CDL", expires: d("2026-06-01") }, { name: "Medical", expires: null }], NOW)).toMatchObject({ tone: "bad", text: "CDL lapsed Jun 1" });
  });
});
