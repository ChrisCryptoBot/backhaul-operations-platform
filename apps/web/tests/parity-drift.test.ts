import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error - vendor-truelane.mjs is an ES module script without d.ts declarations
import { FILES, MOVED } from "../scripts/vendor-truelane.mjs";

/**
 * Phase 0.7: Parity Drift Guard.
 * This test asserts that the vendored math and domain modules in src/truelane/
 * remain in 100% byte-for-byte synchronization with the gold-standard mobile app
 * repo (truelane-prod).
 *
 * READ-ONLY: Never modifies the phone repo.
 * If someone modifies pricing or domain logic in the phone repo, this test fails
 * immediately, ensuring the desk never drifts silently.
 */
const root = process.env.TRUELANE_ROOT ?? "C:/Users/14698/OneDrive/Desktop/TRUELANE";
const dest = path.join(__dirname, "..", "src", "truelane");

describe("Phase 0.7: TrueLane parity drift guard", () => {
  it("vendors exactly 39 files with zero drift from the mobile app gold standard", () => {
    const filesList = FILES as string[];
    const movedList = MOVED as Array<[string, string]>;
    const totalFiles = filesList.length + movedList.length;
    expect(totalFiles).toBe(39);

    const drifted: string[] = [];
    const missingInPhone: string[] = [];
    const missingInDesk: string[] = [];

    const allPairs: Array<[string, string]> = [...filesList.map((f: string): [string, string] => [f, f]), ...movedList];

    for (const [rel, to] of allPairs) {
      const phonePath = path.join(root, rel);
      if (!fs.existsSync(phonePath)) {
        missingInPhone.push(rel);
        continue;
      }
      const phoneContent = fs
        .readFileSync(phonePath, "utf8")
        .replace(/\r\n/g, "\n")
        .replaceAll("'@/lib/", "'@/truelane/lib/")
        .replaceAll("'@/utils/", "'@/truelane/utils/")
        .replaceAll("'@/constants/", "'@/truelane/constants/");

      const deskPath = path.join(dest, to);
      if (!fs.existsSync(deskPath)) {
        missingInDesk.push(to);
        continue;
      }
      const deskContent = fs.readFileSync(deskPath, "utf8").replace(/\r\n/g, "\n");
      // Strip the single-line banner comment injected by vendor-truelane.mjs
      const body = deskContent.replace(/^\/\/ VENDORED from TrueLane [^\n]*\n/, "");

      if (phoneContent !== body) {
        drifted.push(`${rel} -> src/truelane/${to}`);
      }
    }

    expect(missingInPhone, "Files missing in mobile app").toEqual([]);
    expect(missingInDesk, "Files missing in desk src/truelane").toEqual([]);
    expect(drifted, "Vendored files that drifted from mobile app").toEqual([]);
  });
});
