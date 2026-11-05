# Dispatch desk redesign: context for Claude Design

> **Context, not creative direction.** This tells you what the desk is, what it must keep saying, where everything lives in the code, and what your export has to be so it can be built. How it looks, feels, is laid out, moves and is drawn is entirely yours. Nothing here is a hint about the answer.

Everything below is relative to the TrueLane repository root (`TRUELANE/`). The desk is the folder `dispatch-desk/` (its own git repository, branch `demo/truelane-dispatch`; read the local folder, it holds work that is not on GitHub).

---

## 1. The ask, in Chris's own words

Chris is the founder and the person who will judge your output. This is what he said, with only the typos fixed:

> "i dont know how to really explain this look but i want to adopt it. it looks serious and not like ai slop. my edges are so rounded that it makes everything look like pixar or too silly to be taken serious. it looks professional and intentional and even though my system is based on real mechanics it could be mistaken for ai slop. how can we reconcile. i like what i have but im not so in love with it that i wouldnt forsake it for bloomberg type of look. i am going to leverage claude design to actually produce an answer. i want it to redesign what i have to fit the mold im saying based on the product."

**The reference** he means is the Bloomberg Terminal, and the screenshot he attached: `docs/design-reference/bloomberg-terminal-clone-reference.png` (an open-source clone's README, included only to show the register he is pointing at; do not copy its code or branding). He has not told us what about it he likes, in what order, or what to take from it. Working that out is part of the job.

Two things are being asked, in this order:

1. **An answer to "how can we reconcile".** The mechanics here are real and audited, and the interface can still read as generic or machine-made. Looking at this code and its styles, say what specifically produces that impression, and what reconciling the two means for *this* product. Short, specific, pointing at files and screens, not general taste.
2. **The redesign.** The whole desk, redesigned so it fits what he describes, for what this product actually is.

He would give up the current look for the right one. He is not attached to it.

---

## 2. Scope

**In scope: the desktop dispatch desk**, every screen listed in section 5, including the public pages in front of it and the printed documents.

**Out of scope, do not redesign or edit:**
- The mobile app (everything at the repository root outside `dispatch-desk/`: `app/`, `components/`, `lib/`, `android/`, `ds-bundle/` and so on). Read it for context; it is not part of this work.
- The marketing site (`truelane-site/`, `site/`).
- The audited calculation code the desk vendors from the phone (`dispatch-desk/apps/web/src/truelane/`) and the pure rules that decide verdicts (`src/lib/verdict.ts`). Design never computes, re-judges or renames what they decide.

**The project's attached "Design System" is the phone app's** (`ds-bundle/`). It does not describe the desk and must not constrain this work.

**Never open, quote or reproduce any `.env*` file, anything under `.uploads/`, or any key or secret.** The code base you were given may contain real ones. You do not need them: the desk runs on invented sample data.

---

## 3. The product, in brief

**TrueLane** tells a trucker whether a freight load is worth taking, against that truck's own audited cost, before they take it. The phone app does this for one owner-operator. The **dispatch desk** does it for the person who finds and books freight for many trucks: it prices an offer against every truck and driver at once, books it, assigns a driver, tracks the load to delivery, bills the customer, pays the driver, and measures how well the desk is doing.

**Who sits at it.** Dispatchers, fleet owners, accounting and ops people at carriers from 1 truck to 1,500+ tractors (with 5,000+ trailers). All day, desktop, often many loads in flight, money decisions made fast. Fleets are priced by size (`src/lib/plans.ts`); large customers are set up with a person (`/enterprise`).

**What it is not.** There is no chat assistant on the desk (it was removed on purpose). The rate-confirmation reader uses a model to read a document into a draft that a person then checks; every number the desk judges a load with comes from audited math or the person's own records.

**The one constant.** The **verdict card** (Accept, Caution, Reject, or Can't judge yet, with the reason and the ruler of where the load lands against cost and market) is the one thing that must read the same in the phone, on the desk, and anywhere else the product goes. Chris treats it as the heart of the product. Read `docs/VERDICT_CARD.md` for what it must keep saying and where its meaning comes from. Its drawing is open to you.

**Demo state.** Every name, customer, load and number in the repository is invented and the desk runs on a throwaway database. The sidebar says so. Keep that honesty: do not invent real companies.

---

## 4. What must survive (meaning is binding; appearance is open)

Several documents describe the *current* look and its rules. Read them to understand why things are the way they are. **Their rules about meaning bind you; their rules about appearance are history** (say which you keep or drop, and why).

**Binding:**
- **What every number is called and means.** `docs/GLOSSARY.md` gives each figure one canonical name (Floor, All-In, Load Rate, Margin, Left Over and so on). Screens do not invent synonyms or re-derive them.
- **The four verdict states and what triggers each**, the market-versus-lane logic, and the "reason is asked for" rules: `docs/VERDICT_CARD.md`, `src/lib/verdict.ts`.
- **Every datum, state and action the desk offers today still has a home.** If you think something should go, list it as a proposal; do not drop it silently.
- **Voice.** `docs/DESIGN_BRIEF.md` §6: crisp and peer-like, sentence case, dispatcher words, say what is missing rather than that something "failed", say how a figure was got. The word is **Customer**, not broker (`tests/customer-wording.test.ts`).
- **Accessibility baseline.** `docs/DESIGN_BRIEF.md` §7: keyboard path and visible focus on everything, colour never the only signal, headings and landmarks, skip link, dialogs that hold and return focus. Contrast is tested in both themes (`tests/theme-contrast.test.ts`). A verdict must still read with the colour taken away.
- **Fields are kept.** What a person types stays until they change it themselves (`docs/DESIGN_BRIEF.md` rule 13, `tests/forms-keep-fields.test.ts`). Any form you redesign keeps using the desk's `useDraft` (`src/components/desk/kit/use-draft.tsx`).
- **Desktop only.** It must work at 1440 and 1024 wide. No phone layouts.
- **Both themes exist today** (night is the default, day is the other; tokens in `src/app/globals.css`). If you recommend dropping or changing that, say so and why.

**Open to you:** the whole visual language and every choice inside it, information density, layout and navigation structure, hierarchy, typography, colour, iconography, charts, motion, component shapes, the empty/loading/error treatments, naming of UI chrome (not of numbers), how modules relate. You may restructure; if you do, say what moved where.

---

## 5. Where everything is

### The code

Paths in this table are relative to `dispatch-desk/apps/web/` unless they begin with `dispatch-desk/`. Paths beginning `docs/` elsewhere in this brief are `dispatch-desk/docs/`.

| What | Where |
|---|---|
| The desk app | `dispatch-desk/apps/web/` (Next.js 14 App Router, React 18, TypeScript, plain CSS, Prisma and Postgres, Clerk behind a switch) |
| Pages | `src/app/(desk)/<module>/page.tsx`; public pages in `src/app/(public)/` |
| UI components | `src/components/desk/` (about 60 files); shared primitives in `src/components/desk/kit/` (modal, toast, icons, states, submit button, use-draft) |
| Pure logic, no database | `src/lib/` (verdict, quote, plans, roles, KPI periods, planner, alerts, money state, formatting) |
| Data and rules | `src/server/tl/` (queries, actions' bodies, evaluation, invoicing, settlements) |
| The audited math (do not edit) | `src/truelane/` |
| Server actions | `src/app/(desk)/actions.ts` |
| Styles | `src/app/globals.css` (**all tokens, both themes**), `src/app/(desk)/desk.css` (the main sheet), `src/components/desk/cockpit.css`, `quote-terminal.css`, `splash.css`, `public.css` |
| Sample data (use it for your screens) | `dispatch-desk/prisma/schema.prisma` (the data model), `scripts/seed-demo.ts` (the demo fleet), `scripts/seed-scale.ts` (the 1,500-tractor case), `scripts/seed-messages.ts` |
| Tests that pin behaviour | `apps/web/tests/` |

### The screens

| Module | Route (under `src/app/(desk)/`) | Main components |
|---|---|---|
| **Quote a load** (the hero) | `quote/` | `quote-desk.tsx`, `quote-terminal.css`, `verdict-card.tsx`, `live-fuel-price.tsx`, `address-input.tsx`, `date-input.tsx` |
| **Loads** board, and a load as a side drawer and as a page | `loads/`, `@drawer/(.)loads/[id]/`, `loads/[id]/` | `load-view.tsx`, `load-cockpit.tsx` and `cockpit.css`, `drawer-frame.tsx`, `load-actions.tsx`, `disruption-dialogs.tsx`, `load-documents.tsx` |
| **Dispatch queue** | `dispatch/` | `assign-modal.tsx`, `assign-fields.tsx`, `chase-actions.tsx` |
| **Messages** (with drivers, with files) | `messages/` | `components/desk/messages/` |
| **Planner** | `planner/` | `planner-parts.tsx`, `src/lib/planner.ts` |
| **Alerts**, and the rules behind them | `alerts/`, `settings/rules/` | `alert-bits.tsx`, `src/lib/alerts.ts` |
| **Rate confirmations** (read a document into a load) | `rate-cons/` | `rate-con-intake.tsx` |
| **Drivers, Trucks, Trailers** | `drivers/`, `fleet/`, `trailers/` (each with a detail page and a CSV import) | `fleet-forms.tsx`, `trailer-forms.tsx`, `truck-picker.tsx`, `driver-picker.tsx`, `import-panel.tsx` |
| **Customers, Lanes** | `customers/`, `lanes/` | `customer-form.tsx`, `customer-authority.tsx`, `src/lib/customer-scorecard.ts` |
| **Invoices, Settlements, Payroll** | `invoices/`, `settlements/`, `payroll/` | `settlement-forms.tsx`, `billing-details-dialog.tsx`, `doc-head.tsx` (the printed documents) |
| **KPI dashboard**, quote decisions report, management report | `kpi/`, `kpi/quotes/`, `kpi/report/` | `components/desk/kpi/` |
| **Audit log** | `audit/` | `audit-diff-button.tsx`, `src/lib/audit-diff.ts` |
| **Settings** (appearance, company, team, thresholds, integrations) | `settings/`, `settings/requests/` | `company-form.tsx`, `team-card.tsx`, `thresholds-form.tsx`, `partner-actions.tsx` |
| **The shell** around all of it | `layout.tsx` | `desk-shell.tsx` (navigation, header strip, sample-data note), `global-search.tsx`, `terminal-scope.tsx`, `splash.tsx`, `data-table.tsx`, `data-table-tools.tsx`, `ui.tsx`, `underlay.tsx` |
| **Public pages** | `src/app/(public)/`: `sign-in`, `sign-up`, `enterprise`, `no-workspace` | `components/desk/public/` |

**Screens the product lives or dies on:** Quote a load, the Loads board and a load's drawer, and the Dispatch queue. The rest should feel like the same product.

### States and variants every screen has to account for

Find them in the code; do not assume they are rare.

- Both themes; 1440 and 1024 wide.
- Roles and read-only: viewer, dispatcher, accounting, admin (`src/lib/roles.ts`); a viewer sees a banner and no action buttons. A passed quote opens read-only.
- Plan limits and "plan full" states (`plan-limit.tsx`, `src/lib/plans.ts`).
- Empty, loading (`loading.tsx`), error (`error.tsx`), not found, "that was booked or discarded since you opened it".
- From 1 truck to 1,500+: paging, sorting, filtering, and what a 50-row fleet table looks like next to a 3-row one.
- Money in every state: draft, sent, accepted, in progress, delivered, invoiced, overdue, paid, short-paid, written off.
- Dialogs and confirmations (reschedule, TONU, cancel, delete with undo, assign, mark paid, void), toasts with Undo, the date picker, address autocomplete, the global search.
- The printed and PDF documents (invoice, driver statement, management report).

### Context, if you want it

- `docs/DESIGN_BRIEF.md`, `docs/VERDICT_CARD.md`, `docs/DESK_REWORK_PLAN.md`: how the current look was arrived at, and why.
- `docs/DEMO_REBUILD.md`, `docs/HANDOFF_2026-10-30_AFTER_E4.md`, `docs/CONVERGENCE_BUILD_PLAN.md`: how the desk got built, what each wave added.
- `docs/LOADS_MODULE_STATUS.md`, `docs/INVOICES_MODULE_STATUS.md`: what those modules do and where they are rough.
- `../docs/PIVOT.md` (why the product exists and who it is for), `../docs/ORBIT.md` (state of the whole product), `../docs/tabs/` (per-tab specs for the phone).
- `../docs/ui-atlas/` (screenshots of the phone app). Reading the mobile app is encouraged; changing it is out of scope.
- `../DESIGN UPGRADES/` (earlier Claude Design runs for the phone, for how past briefs were framed).

---

## 6. What the current look is made of (facts, no judgement)

So you do not have to hunt for it:

- **One token file**, `src/app/globals.css`, defines colours, type scale, spacing, radii and shadows for both themes; the three component sheets and `desk.css` read from it.
- Corner radii are tokens from 4px up to 20px (`--db-r-sm` 4, `--db-r-md` 8, `--db-r-lg` 12, `--db-r-note` 14, `--db-r-card` 20), plus fully round pills; 59 declarations use the 8px token, 10 use the 20px card radius, 6 use `999px`.
- The desk sheets contain 17 `backdrop-filter` (glass) uses, 14 gradients and about 53 `box-shadow` declarations.
- Fonts are Barlow and Barlow Condensed.

---

## 7. What to deliver

The export will be taken by another engineer (a Claude) and built into the real code. It has to be buildable, so:

1. **The answer to "how can we reconcile"** (section 1, item 1), first, as a short written note.
2. **The redesign as real code on real screens**, not pictures alone: HTML, CSS and React that use the actual data shapes in the code and the seed data, for **every screen in section 5** and the states in the list above. The repository's component and file names are your map; keep them where it helps, rename where it does not.
3. **The system the screens share**: tokens (both themes, or your recommendation), type, spacing, the primitives, and the verdict card, with a short account of how it is meant to be used.
4. **`INTEGRATION.md`** at the root of the export, for each screen: which existing files it replaces or changes, which existing components it maps to, what is new, the old-to-new map for tokens and CSS classes, and anything that needs data or behaviour the code does not have today. **Flag those; do not invent them.**
5. **Proposals kept separate.** Anything that changes what the product does, what a number means, who can do what, or what a screen contains is a proposal, listed on its own, not folded into the visual work.

Plain CSS and tokens fit the existing build (there is no Tailwind or CSS-in-JS; a new runtime dependency needs a reason). Pages are server components and only what needs state is a client component.

Test your assumptions against the code, not against how a desk like this usually looks. The people who built it chose its behaviour on purpose.
