import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { deckHero } from "../src/lib/deck-hero";

describe("what leads the load deck", () => {
  test("a load with a floor leads with its margin against it, and gross pay sits on the summary line", () => {
    const h = deckHero({ tonu: false, allIn: 2.15, floor: 1.66, verdictTone: "ok" });
    expect(h.lead).toBe("margin");
    expect(h.margin).toBeCloseTo(0.49, 2);
    expect(h.grossInLine).toBe(true);
    expect(h.tone).toBe("ok");
  });

  test("under the floor reads negative and takes the bad square when the verdict has no tone of its own", () => {
    const h = deckHero({ tonu: false, allIn: 1.11, floor: 1.74 });
    expect(h.margin).toBeCloseTo(-0.63, 2);
    expect(h.tone).toBe("bad");
  });

  test("a load with no floor yet leads with gross pay, so the header is never blank", () => {
    for (const floor of [0, -1]) {
      const h = deckHero({ tonu: false, allIn: 2.15, floor });
      expect(h.lead).toBe("gross");
      expect(h.margin).toBeNull();
      expect(h.hasFloor).toBe(false);
      expect(h.grossInLine).toBe(false);
    }
    expect(deckHero({ tonu: false, allIn: null, floor: 1.66 }).lead).toBe("gross");
    expect(deckHero({ tonu: false, allIn: Number.NaN, floor: 1.66 }).lead).toBe("gross");
  });

  test("a TONU leads with the fee earned", () => {
    expect(deckHero({ tonu: true, allIn: 2, floor: 1.5 }).lead).toBe("tonu");
  });
});

describe("the load drawer keeps gross pay in its summary and leaves Relay and Recall alone", () => {
  const SRC = join(__dirname, "..", "src");
  const view = readFileSync(join(SRC, "components", "desk", "load-view.tsx"), "utf8").split(String.fromCharCode(13)).join("");

  test("the summary carries the gross pay, the every-mile and loaded rates and the floor", () => {
    const sum = view.slice(view.indexOf('<dl className="lv-stats">'), view.indexOf("</dl>", view.indexOf('<dl className="lv-stats">')));
    expect(sum).toContain('<dt>{delivered ? "Paid" : "Gross"}</dt>');
    expect(sum).toContain("{deckGross}");
    expect(sum).toContain("{perMile(allIn)}");
    expect(sum).toContain("{`${perMile(perLoaded)} loaded`}");
    expect(sum).toContain("floor ${perMile(floorThreshold)}");
  });

  test("the unjudged hero is the gross pay", () => {
    expect(view).toMatch(/h\.lead === "gross"|deckLead\.lead === "gross"|deckGross;/);
  });

  test("the Relay hand-off and the recall reason form are still wired into the load view", () => {
    expect(view).toMatch(/RecallForm/);
    expect(view).toMatch(/Relay|relay/);
    expect(view).toMatch(/recall-form/);
  });
});
