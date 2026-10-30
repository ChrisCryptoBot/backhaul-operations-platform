# Sign-in on the desk (built dark, off by default)

Built 2026-10-30 as Part B of the audit plan. **Nothing here runs until `DESK_AUTH=on`.** With it off the desk is the demo's, exactly as before. It has **not been run against a real Clerk instance**: the provider is stood in for in the tests, and a sign-in was never attempted (no account was made, no password typed). Switching it on is Chris's call.

## How it works

1. **Clerk proves who someone is.** The front door (`src/middleware.ts`, rules in `src/lib/auth-route.ts`) sends anyone not signed in to `/sign-in` (a fetch or a change gets a 401). The splash, sign-in, sign-up, enterprise, "no desk yet" and sign-out pages stay open.
2. **The member table says which desk and what role.** `members` (workspace, email, role `viewer | dispatcher | owner`, the provider's user id once bound). A signed-in person lands on `/auth/enter`, which finds their row (by user id, or by their **verified** email the first time, and binds it), and gives them a **signed session cookie** `desk-session` (HMAC-SHA256 with `DESK_SESSION_SECRET`, one hour, tied to their Clerk user id so it is useless without that sign-in). Nobody added them → `/no-workspace`.
3. **Every page, action and route asks the member table again** (`src/server/tl/access.ts`): `requirePage` (the desk layout), `requireMember(role)` (the first line of every server action), `guardRoute(role)` (the first line of every route handler). Taking someone off the desk, or lowering their role, takes effect on their next click, not when the cookie runs out. `tests/auth-guard.test.ts` fails on any action or route that skips it.
4. **The workspace comes from the session.** `currentWorkspaceId()` reads it from the signed-in person; with sign-in on and nobody signed in it throws, never falling back to the demo's data. The development cookie seam (`DESK_WORKSPACE_COOKIE`) is ignored in production and when sign-in is on.
5. **Audit events carry the person's name** (the actor was the literal "Dispatcher").

Roles: a **viewer** looks and changes nothing; a **dispatcher** quotes, dispatches, bills, pays drivers and imports; an **owner** also changes the company, thresholds, connections and the team. (The server enforces this; the screens do not yet grey out buttons for a viewer, so a viewer who clicks gets "Your role on this desk does not allow that.")

Seats (a proposal, in `src/lib/plans.ts`): Starter 1, Growth 3, Pro 10, Enterprise no automatic limit. Adding a person past it is refused. A desk keeps one owner; a person is on one desk.

The sign-up requests (who asked for an account, with names and phones) belong to the people who run TrueLane, not to a customer's desk: only the emails in `DESK_ADMIN_EMAILS` see them.

Paid lookups (`geo/*`, FMCSA, EIA) have a daily allowance per desk (`src/server/tl/budget.ts`). It lives in the server's memory, so it is a brake, not an exact meter; the exact one for rate-con reads is in the database.

## To switch it on (Chris)

1. In the Clerk dashboard (use a **separate Clerk application** for the desk if you do not want desk users mixed with the phone's, which is `usable-crayfish-4068`): turn sign-up OFF or restrict it to invitations/allow-list. The desk does not rely on that (a stranger who signs up has no member row and gets nothing), but it keeps the user list clean.
2. Set in the desk's environment (never commit them): `DESK_AUTH=on`, `DESK_SESSION_SECRET` (32+ random characters), `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `DESK_ADMIN_EMAILS=you@...`.
3. Apply the migration `20261110000000_members` (already applied on the local demo and demo_scale databases only). Then put yourself on the demo desk **before** switching on: either Settings → Team (with sign-in off the demo is an owner), or
   `DATABASE_URL=... npx tsx apps/web/scripts/add-member.ts demo-workspace you@example.com "Your Name" owner`.
4. Provisioning a large fleet (`scripts/provision-enterprise.ts <requestId>`) now also makes the requester the desk's first **owner** by their email, and puts the workspace on the plan its truck count falls in.
5. Sign in with that email. Check: signed out → `/sign-in`; a stranger's email → `/no-workspace`; Sign out ends both sessions.

## Not verified, not built

- No live Clerk sign-in, no sign-out against Clerk, and no run of the middleware with real keys (a production `next build` compiles it at 61.7 kB; the front-door rules and everything behind it are tested).
- Viewer-role screens do not hide or disable the buttons a viewer cannot use.
- A member's role/name changes in the table show in the sidebar only after the cookie is remade (an hour, or sign out and in); the checks themselves read the table every time.
- The public sign-up/enterprise forms have no rate limit or captcha (Part F).
- Desk billing, per-seat Stripe, SSO and Clerk organizations are out of scope.
