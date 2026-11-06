import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A form in the desk keeps what was typed until the person changes it themselves: leaving for another module or refreshing does not lose it (components/desk/kit/use-draft.tsx).
 *
 * This is a scan, not a list. Every file under src/components and src/app that draws a typed control (a text, number, date, select or text area, the desk's own Money, DateInput and
 * AddressInput) has to use `useDraft`, or be named in EXEMPT below with the reason it does not need to. A new form with typed fields fails here until it does one or the other.
 */
const SRC = join(__dirname, "../src");
const ROOTS = ["components", "app"].map((d) => join(SRC, d));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : [];
  });
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const source = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Input types that are not typed text: nothing to lose. (Checkboxes and radios are choices made and used at once, or read by the form around them.) */
const NOT_TYPED = /type=["'](hidden|file|checkbox|radio|submit|button|reset|image)["']/;

/** Whether a file draws a control a person types or picks a value into. */
function drawsTypedControl(src: string): boolean {
  if (/<(textarea|select|Money|AddressInput|DateInput)\b/.test(src)) return true;
  for (const m of src.matchAll(/<input\b/g)) {
    // The tag runs to the next tag: an attribute never holds a "<" in this code base.
    const end = src.indexOf("<", m.index! + 1);
    const tag = src.slice(m.index!, end === -1 ? undefined : end);
    if (!NOT_TYPED.test(tag)) return true;
  }
  return false;
}

/** Files that draw a typed control and are right not to keep it, each with why. Keep this short: the answer is nearly always to keep the fields. */
const EXEMPT: Record<string, string> = {
  // Keeps its own, because a read cost a paid call and the file cannot go into a draft.
  "components/desk/rate-con-intake.tsx": "keeps its own review: in memory, sessionStorage and IndexedDB (the file itself)",
  // A file cannot be stored in a draft.
  "components/desk/load-documents.tsx": "a file chooser: the file cannot be kept, and its kind is picked with it",
  // Parts a form is built from: the value belongs to the form around them, which keeps it.
  "components/desk/date-input.tsx": "a building block: the value belongs to the form around it",
  "components/desk/address-input.tsx": "a building block: the value belongs to the form around it",
  "components/desk/truck-picker.tsx": "a picker: the choice belongs to the form around it",
  "components/desk/driver-picker.tsx": "a picker: the choice belongs to the form around it",
  "components/desk/copy-text.tsx": "a read-only box to copy from",
  // Chosen and used at once.
  "components/desk/integrations-panel.tsx": "secrets: typed once, sent to the server and emptied; a key must never be kept in a draft or in browser storage",
  "components/desk/public/demo-sign-in.tsx": "display-only demo fields filled by its one button; nothing is typed, kept or checked",
  "components/desk/global-search.tsx": "a search box: a result is picked at once",
  "components/desk/kit/modal.tsx": "a confirmation's reason is typed where it is asked and sent at once",
  // A filter or a pick that goes into the address (GET): the sidebar remembers it per module (rememberedQuery).
  "components/desk/data-table-tools.tsx": "a search and filter that go into the address",
  "components/desk/live-form.tsx": "a filter form that goes into the address",
  "components/desk/kpi/choice.tsx": "a filter box that goes into the address (the filter form around it applies the chosen name)",
  "app/(desk)/trailers/page.tsx": "filters that go into the address",
  "app/(desk)/audit/page.tsx": "filters that go into the address",
  "app/(desk)/planner/page.tsx": "filters that go into the address",
  "app/(desk)/schedules/page.tsx": "a search that goes into the address; the shift editor itself (components/desk/roster-table.tsx) keeps its fields with useDraft",
  "app/(desk)/messages/page.tsx": "picks a conversation, which goes into the address",
  "app/(desk)/settings/page.tsx": "appearance buttons that save at once"
};

const scanned = ROOTS.flatMap(files);
const typed = scanned.filter((p) => drawsTypedControl(source(p)));

describe("forms keep their fields", () => {
  test("the scan sees the desk's forms", () => {
    // If this drops to a handful, the scan has stopped finding them rather than the desk having lost them.
    expect(typed.length).toBeGreaterThan(25);
    expect(typed.map(rel)).toEqual(expect.arrayContaining(["components/desk/quote-desk.tsx", "components/desk/disruption-dialogs.tsx", "components/desk/public/request-form.tsx"]));
  });

  test("every file with typed controls uses useDraft, or is exempt for a stated reason", () => {
    const loose = typed.filter((p) => !source(p).includes("useDraft") && !(rel(p) in EXEMPT)).map(rel);
    expect(loose, `These draw typed fields and forget them when the person leaves. Use useDraft (components/desk/kit/use-draft.tsx), or add the file to EXEMPT with why:\n${loose.join("\n")}`).toEqual([]);
  });

  test("an exemption is kept honest: the file exists, still has typed controls, and does not use useDraft", () => {
    for (const [name, why] of Object.entries(EXEMPT)) {
      const p = join(SRC, name);
      expect(() => statSync(p), `${name} is exempt but is gone: remove it from EXEMPT`).not.toThrow();
      expect(why.length, name).toBeGreaterThan(10);
      expect(drawsTypedControl(source(p)), `${name} has no typed controls any more: remove it from EXEMPT`).toBe(true);
      expect(source(p).includes("useDraft"), `${name} uses useDraft: remove it from EXEMPT`).toBe(false);
    }
  });

  test("a form's own values are never plain state in the files that keep them", () => {
    // The values of a form are named `values`, `v`, `f` or `person`; a plain useState on one of them is a form that forgets.
    const plain = /const \[(values|person|f|v), set\w+\] = React\.useState/;
    const offenders = typed.filter((p) => source(p).includes("useDraft") && plain.test(source(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  test("a dialog does not wipe what is kept when it opens", () => {
    // Opening a dialog must show what was typed, so the buttons that open them do not set their fields back to blank.
    const wipes: Record<string, RegExp[]> = {
      "components/desk/delete-load.tsx": [/setReason\(""\)/, /setNote\(""\)/],
      "components/desk/load-actions.tsx": [/setAmount\(due\.toFixed\(2\)\);\n\s+setPaidOn/],
      "components/desk/settlement-forms.tsx": [/setPaidOn\(today\(\)\);\n\s+setMethod\("check"\)/],
      "components/desk/quote-desk.tsx": [/setPassReason\(""\);\n\s+setPassNotes\(""\);\n\s+setPassing\(true\)/]
    };
    for (const [file, patterns] of Object.entries(wipes)) for (const re of patterns) expect(re.test(source(join(SRC, file))), `${file} wipes a kept field on open: ${re}`).toBe(false);
  });

  test("the sidebar remembers where each module was left", () => {
    const src = source(join(SRC, "components/desk/desk-shell.tsx"));
    expect(src).toContain("rememberedQuery");
    expect(src).toContain("DraftScope");
  });
});

describe("what is kept is kept under the right name", () => {
  test("each quote, and each quote started from a load, is its own draft", () => {
    const page = source(join(SRC, "app/(desk)/quote/page.tsx"));
    const desk = source(join(SRC, "components/desk/quote-desk.tsx"));
    expect(page).toMatch(/const draftId = id \?\? \(likeId \? `like-\$\{likeId\}` : "new"\)/);
    expect(page).toContain("draftId={draftId}");
    expect(desk).toContain("const draftKey = `quote:${draftId}`");
  });

  test("the booking, pass and quick-paste text and the picked truck are kept with the quote, and the view with the person", () => {
    const desk = source(join(SRC, "components/desk/quote-desk.tsx"));
    expect(desk).toContain("useDraft<QuoteAsk>(`${draftKey}:ask`");
    expect(desk).toContain('useDraft<QuoteView>("quote-view"');
  });

  test("the hook resets its baseline when what the form starts from changes, not when a new object with the same content is passed", () => {
    const hook = source(join(SRC, "components/desk/kit/use-draft.tsx"));
    expect(hook).toContain("}, [initialJson]);");
    expect(hook).not.toContain("}, [initial, initialJson]);");
  });

  test("the request forms are forgotten once the request has gone through, and the unsent ones are not", () => {
    for (const page of ["app/(public)/sign-up/thanks/page.tsx", "app/(public)/enterprise/thanks/page.tsx"]) {
      const src = source(join(SRC, page));
      expect(src).toContain('<ForgetDraft draftKey="request:self" />');
      expect(src).toContain('<ForgetDraft draftKey="request:enterprise" />');
    }
  });

  test("a form that posts to a redirecting action clears only when the redirect says it worked", () => {
    const outcome = source(join(SRC, "components/desk/kit/use-submit-outcome.tsx"));
    expect(outcome).toMatch(/if \(note\) \{\s+waiting\.current = null;\s+worked\(\);\s+\} else if \(error\) \{\s+waiting\.current = null;\s+\}/);
    for (const f of ["components/desk/disruption-dialogs.tsx", "components/desk/assign-fields.tsx", "components/desk/load-view-fields.tsx"]) {
      expect(source(join(SRC, f)), f).toMatch(/useSubmitOutcome|useClearOnSuccess/);
    }
  });
});
