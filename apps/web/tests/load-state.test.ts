import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { loadStatusFor, statesAgree } from "@/lib/load-state";

describe("the two statuses of a load", () => {
  test("an assignment that has not been said yes to goes with a draft load; yes, the road and delivered go with theirs", () => {
    expect([null, "draft", "dispatched", "declined"].map((a) => loadStatusFor(a))).toEqual(["draft", "draft", "draft", "draft"]);
    expect(["accepted", "in_progress", "completed"].map((a) => loadStatusFor(a))).toEqual(["accepted", "in_progress", "completed"]);
  });

  test("agreement: a load that was accepted by the last driver with a new assignment sent is the disagreement this guards against", () => {
    expect(statesAgree("draft", null)).toBe(true);
    expect(statesAgree("draft", "dispatched")).toBe(true);
    expect(statesAgree("draft", "declined")).toBe(true);
    expect(statesAgree("accepted", "accepted")).toBe(true);
    expect(statesAgree("accepted", "dispatched")).toBe(false);
    expect(statesAgree("accepted", "draft")).toBe(false);
    expect(statesAgree("in_progress", "accepted")).toBe(false);
    expect(statesAgree("completed", "completed")).toBe(true);
  });

  test("a cancelled load, a TONU and a saved quote have left the table, whatever their assignment says", () => {
    expect(statesAgree("cancelled", null)).toBe(true);
    expect(statesAgree("tonu", "completed")).toBe(true);
    expect(statesAgree("quote", null)).toBe(true);
  });
});

describe("the places that send an assignment back to the driver keep the load in step", () => {
  const SRC = path.join(__dirname, "..", "src", "server");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? files(path.join(dir, n)) : n.endsWith(".ts") ? [path.join(dir, n)] : []));

  test("every write that asks a driver again (back to dispatched with the answer cleared) sets the load's status from the table too", () => {
    const asking = files(SRC).filter((f) => /status: "dispatched", dispatchedAt: now, respondedAt: null/.test(readFileSync(f, "utf8")));
    expect(asking.map((f) => path.basename(f)).sort()).toEqual(["disruptions.ts", "edit.ts"]);
    for (const f of asking) expect(readFileSync(f, "utf8"), path.basename(f)).toContain("loadStatusFor(");
  });

  test("assigning a driver and recording the driver's answer do too", () => {
    const dispatch = readFileSync(path.join(SRC, "tl", "dispatch.ts"), "utf8");
    expect(dispatch.match(/loadStatusFor\(/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
