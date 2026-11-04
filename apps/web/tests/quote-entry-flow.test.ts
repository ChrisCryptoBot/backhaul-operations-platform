import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The quick way through a quote, and the things around it: Enter moves on (Tab does not change), Clear and the swap can be undone,
 * and Copy Brief cannot throw. The terminal has no component tests in this repo, so these read the source for the properties that must stay true.
 */
const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const desk = read("src/components/desk/quote-desk.tsx");
const address = read("src/components/desk/address-input.tsx");
const icons = read("src/components/desk/kit/icons.tsx");

describe("Enter moves on, and Tab is left alone", () => {
  test("nothing in the quote form reorders Tab: no positive tabindex and no Tab key handler", () => {
    for (const src of [desk, address]) {
      expect(src).not.toMatch(/tabIndex=\{?["']?[1-9]/);
      expect(src).not.toMatch(/key === "Tab"/);
    }
  });

  test("Enter goes Pickup, the next stop, Delivery, Offer, Loaded miles, then the Book button", () => {
    expect(desk).toMatch(/onEnter=\{\(\) => \(last \? focusId\("qt-offer"\) : focusAddress\(i \+ 2\)\)\}/);
    expect(desk).toMatch(/<Money label="Offer"[^\n]*onEnter=\{\(\) => focusId\("qt-loaded"\)\}/);
    expect(desk).toMatch(/<Money label="Loaded"[^\n]*onEnter=\{focusDone\}/);
  });

  test("the Book button is only given focus, never pressed: Ctrl+Enter is the way to book", () => {
    expect(desk).toMatch(/const focusDone = \(\) => document\.querySelector<HTMLElement>\("\.qt-actions button:not\(\[disabled\]\)"\)\?\.focus\(\);/);
    expect(desk).not.toMatch(/qt-actions button[^\n]*\.click\(\)/);
  });

  test("in the address box, Enter still picks a suggestion that is highlighted, and moves on only when none is", () => {
    expect(address).toMatch(/e\.key === "Enter" && onEnter && !e\.nativeEvent\.isComposing && !\(open && places\.length > 0 && active >= 0\)/);
    expect(address).toMatch(/else if \(e\.key === "Enter" && active >= 0\)/);
  });

  test("in the money boxes, only Enter is taken (and not while a word is being composed)", () => {
    const money = desk.slice(desk.indexOf("function Money("), desk.indexOf("/** What the audited math said"));
    expect(money).toMatch(/if \(e\.key === "Enter" && !e\.nativeEvent\.isComposing\)/);
    expect(money).not.toMatch(/key === "(Tab|ArrowDown|ArrowUp)"/);
  });

  test("the shortcuts dialog says so", () => {
    expect(desk).toMatch(/<b>Next field<\/b> in Pickup, Delivery, Offer and Loaded miles, then the Book button/);
  });
});

describe("Clear and the swap can be undone", () => {
  test("the Clear button goes through the Undo, not straight to reset", () => {
    expect(desk).toMatch(/onClick=\{clearWithUndo\}\s*title="Clear form and start a new quote/);
  });

  test("Quote another, on the booked screen, still starts over with a plain reset: there is nothing to undo there", () => {
    expect(desk).toMatch(/onClick=\{reset\}>\s*Quote another/);
  });

  test("`reset` is as it was: Pass and Quote another still use it, and it carries no Undo of its own", () => {
    expect(desk).toMatch(/const reset = \(\) => \{\s*draft\.discard\(\);\s*setValues\(BLANK_QUOTE\);/);
    expect(desk).toMatch(/const clearWithUndo = \(\) => \{[\s\S]*?reset\(\);[\s\S]*?reset\(\);/);
  });

  test("Clear and the swap each offer an Undo that puts the snapshot back, for at least the toast's own floor", () => {
    expect((desk.match(/label: "Undo", run: \(\) => restore\(snap\)/g) ?? []).length).toBe(2);
    expect((desk.match(/ms: 8000/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("a form with nothing in it is cleared without an Undo", () => {
    expect(desk).toMatch(/if \(!isQuoteDirty\(values, BLANK_QUOTE\) && quoteId == null\) \{\s*reset\(\);\s*return;/);
  });

  test("restoring stops a measure still on its way, and measures again if the snapshot was taken mid-measure", () => {
    const restore = desk.slice(desk.indexOf("const restore = "), desk.indexOf("/** Clear, with an Undo."));
    expect(restore).toMatch(/measureSeq\.current \+= 1/);
    expect(restore).toMatch(/lastRoute\.current = measuring \? "" : snap\.lastRoute/);
    expect(restore).toMatch(/manual\.current = new Set\(snap\.values\.manual\)/);
  });

  test("the swap stops an old measure too, and uses the tested pure swap", () => {
    const swap = desk.slice(desk.indexOf("const swapStops = "), desk.indexOf("// The fast way through a quote"));
    expect(swap).toMatch(/swapRoute\(values\)/);
    expect(swap).toMatch(/measureSeq\.current \+= 1/);
    expect(swap).toMatch(/manual\.current = new Set\(next\.manual\)/);
  });

  test("the swap button is named, switched off when the quote is locked, and sits after the first stop", () => {
    expect(desk).toMatch(/aria-label="Swap pickup and delivery"[^\n]*disabled=\{locked\}[^\n]*onClick=\{swapStops\}/);
    expect(desk).toMatch(/\{first && stopCount >= 2 \? \(\s*<li className="qt-swap">/);
    expect(icons).toMatch(/swap: "/);
  });
});

describe("Copy Brief", () => {
  test("is a menu of the three texts, in the desk's own menu pattern, with a warning on the internal one", () => {
    expect(desk).toMatch(/<details className="menu qt-brief">/);
    expect(desk).toMatch(/\(\["customer", "driver", "dispatch"\] as const\)\.map/);
    expect(desk).toMatch(/BRIEF_LABEL\[kind\]/);
    expect(desk).toMatch(/Includes our truck and margin\. For the team, not the customer\./);
  });

  test("the clipboard is only ever written inside a try, so a browser without it cannot throw", () => {
    expect((desk.match(/navigator\.clipboard\.writeText/g) ?? []).length).toBe(1);
    expect(desk).toMatch(/try \{\s*await navigator\.clipboard\.writeText\(text\);/);
  });

  test("when the browser will not copy, the text opens in a dialog, selected", () => {
    expect(desk).toMatch(/setBriefFallback\(\{ label: BRIEF_LABEL\[kind\], text \}\)/);
    expect(desk).toMatch(/<textarea data-autofocus readOnly[^\n]*onFocus=\{\(e\) => e\.currentTarget\.select\(\)\}/);
  });

  test("our own figures are handed over only from the chosen truck's row, and only the dispatch note reads them", () => {
    expect(desk).toMatch(/internal: row \? \{ truckName: row\.truckName, allInPerMile: row\.allInPerMile, marginPerMile: row\.marginPerMile \} : undefined/);
  });
});

describe("the rest of the terminal's rules still hold", () => {
  test("there is still exactly one live region in the terminal: the verdict panel", () => {
    expect(desk.match(/aria-live="polite"/g)).toHaveLength(1);
  });
});
