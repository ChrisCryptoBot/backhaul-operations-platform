import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A form in the desk keeps what was typed until the person changes it themselves: leaving for another module or refreshing does not lose it (components/desk/kit/use-draft.tsx).
 * Each file here holds a form whose fields are typed by hand and not yet saved, so each has to use that hook. A new form with typed fields belongs in this list.
 * Not on it on purpose: search boxes and filters (they live in the address and are remembered by the sidebar), pickers whose choice is made and used at once, and file choosers
 * (a file cannot be kept in a form; the rate-confirmation review keeps its own).
 */
const FORMS = [
  "quote-desk.tsx",
  "company-form.tsx",
  "customer-form.tsx",
  "team-card.tsx",
  "thresholds-form.tsx",
  "fleet-forms.tsx",
  "trailer-forms.tsx",
  "settlement-forms.tsx",
  "load-actions.tsx",
  "messages/composer.tsx"
];

describe("forms keep their fields", () => {
  for (const f of FORMS) {
    test(`${f} uses useDraft`, () => {
      const src = readFileSync(join(__dirname, "../src/components/desk", f), "utf8");
      expect(src).toContain("useDraft");
    });
  }

  test("a form's own values are never plain state in the forms above", () => {
    // The values of the forms are named `values`, `v`, `f` or `person`; a plain useState on one of them is a form that forgets.
    const plain = /const \[(values|person|f|v), set\w+\] = React\.useState/;
    for (const f of FORMS) {
      const src = readFileSync(join(__dirname, "../src/components/desk", f), "utf8");
      expect(plain.test(src), f).toBe(false);
    }
  });

  test("the sidebar remembers where each module was left", () => {
    const src = readFileSync(join(__dirname, "../src/components/desk/desk-shell.tsx"), "utf8");
    expect(src).toContain("rememberedQuery");
    expect(src).toContain("DraftScope");
  });
});
