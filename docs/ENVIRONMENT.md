# Environment variables

Every variable the desk reads, in one place. **Names only: no value is written here, in the repo or in a log.** Set them in the host's environment (Vercel project settings, or the shell for local work); `apps/web/.env.local` is for a developer's machine and is never committed. `tests/environment-doc.test.ts` fails if the source reads a variable this page does not name, so a new one cannot go undocumented.

Legend: **Required** = the desk does not work without it. **Secret** = never printed, logged, sent to a browser or stored in the database. "Off" means the feature is dark until it is set.

## Core
| Name | Required | Secret | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | yes | The Postgres connection (Prisma). One database for the whole desk; every row carries its workspace. |
| `NODE_ENV` | set by the host | no | `production` makes cookies `secure` and ignores the development workspace cookie. |
| `NEXT_DIST_DIR` | no | no | A production build can go to its own folder (for example `.next-prod`) so a check never disturbs the dev server. |

## Sign-in and tenancy
| Name | Required | Secret | What it does |
|---|---|---|---|
| `DESK_AUTH` | no | no | `on` turns real sign-in on (Clerk). Anything else is the demo desk, which has its own one-button demo sign-in. |
| `DESK_SESSION_SECRET` | with `DESK_AUTH=on` | yes | Signs the desk's session cookie; 32 characters or more. Without it sign-in answers 503. |
| `CLERK_PUBLISHABLE_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | with `DESK_AUTH=on` | no | The Clerk instance the desk signs people in with (the public key is allowed in the browser). |
| `CLERK_SECRET_KEY` | with `DESK_AUTH=on` | yes | Read by the Clerk SDK itself, not by desk code. Listed because sign-in does not work without it. |
| `DESK_ADMIN_EMAILS` | no | no | Comma-separated emails of platform admins (people who see every fleet's sign-up requests). Not a role on any desk. |
| `DESK_WORKSPACE_COOKIE` | no | no | `on` lets a development cookie pick the workspace. Ignored in production and when sign-in is on. |
| `DEMO_LOGIN` | no | no | `off` turns the demo sign-in door off (the desk is then open when sign-in is off, as it was). Never read when `DESK_AUTH=on`. |

## Outside services the desk calls (each is off until its key is set)
| Name | Required | Secret | What it does |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | for the rate-confirmation reader | yes | Reads a rate confirmation into a draft a person checks. Metered per plan per day. |
| `MAPBOX_ACCESS_TOKEN` | for address search and miles | yes | Suggestions, geocoding and routes, server side only. |
| `EIA_API_KEY` | for live diesel prices | yes | Weekly regional fuel price. |
| `FMCSA_WEBKEY` | for authority lookups | yes | Carrier and broker authority by MC or DOT. |
| `DESK_SERVICES_OFF` | no | no | The kill switch: `mapbox_geocode,anthropic_desk` (or `all`) switches those services off whatever the keys say. |
| `DESK_SPEND_METER` | no | no | `off` turns the spend ledger off (unit tests, which have no database). |
| `DESK_UPLOAD_DIR` | no | no | Where attachments are kept on disk when the host has a writable folder for them. |

## The driver link (docs/DRIVER_LINK_DESIGN.md; dark until all three are set)
| Name | Required | Secret | What it does |
|---|---|---|---|
| `BRIDGE_SUPABASE_URL` | for the link | no | The Supabase project the bridge table lives in (`https://...`). |
| `BRIDGE_SUPABASE_SERVICE_KEY` | for the link | yes | The service key the desk writes the bridge table with. Read at the moment of each call. |
| `BRIDGE_CRON_SECRET` | for the link | yes | The secret the schedule sends (header `x-bridge-cron`) to `POST /bridge/cron`. Without it the route answers 404. |

A fleet is switched on by setting its Clerk Organization id on the workspace (`workspaces.bridge_org_id`) and each driver's phone account (`drivers.phone_user_id`); neither is an environment variable.

## The partner backbone (docs/PARTNER_BACKBONE.md)
| Name | Required | Secret | What it does |
|---|---|---|---|
| `DESK_CREDENTIAL_KEY` | to let a fleet keep its own keys | yes | 32 random bytes in base64. Seals each fleet's partner keys (AES-256-GCM) before they are stored; the database alone opens nothing. Without it, a fleet cannot save keys and Settings says so. Losing it loses the stored keys (they must be pasted again). |
| `DESK_CREDENTIAL_KEY_PREVIOUS` | only while rotating | yes | The old `DESK_CREDENTIAL_KEY`, kept for as long as some fleet's keys are still sealed under it. To rotate: set the new key as `DESK_CREDENTIAL_KEY` and the old one here; keys sealed under the old one still read, and the schedule re-seals them under the new one (its answer says how many: `resealed`, and `unreadable` for rows neither key opens). Remove this when `resealed` is 0 on a run. |
| `PARTNER_CRON_SECRET` | for the schedule | yes | The secret the schedule sends (header `x-partner-cron`) to `POST /partners/cron`, which reads the connections that run on a clock (ELD hours, carrier checks), re-seals keys after a rotation, and removes webhook events older than 90 days. Without it the route answers 404. |

## Partner companies (docs/platform/PARTNER_API_READINESS.md; each is off until its keys are set and a fleet connects it)
| Name | Secret | Company and use |
|---|---|---|
| `TRIUMPHPAY_API_KEY`, `TRIUMPHPAY_WEBHOOK_SECRET` | yes | Factoring |
| `MOTIVE_API_KEY`, `MOTIVE_WEBHOOK_SECRET` | yes | ELD and hours |
| `SAMSARA_API_KEY`, `SAMSARA_WEBHOOK_SECRET` | yes | ELD and hours |
| `ATOB_API_KEY`, `ATOB_WEBHOOK_SECRET` | yes | Fuel cards |
| `WEX_API_KEY`, `WEX_WEBHOOK_SECRET` | yes | Fuel cards |
| `PROJECT44_CLIENT_ID`, `PROJECT44_CLIENT_SECRET`, `PROJECT44_WEBHOOK_SECRET` | yes | Load tracking |
| `FOURKITES_API_KEY`, `FOURKITES_WEBHOOK_SECRET` | yes | Load tracking |
| `HIGHWAY_API_KEY`, `HIGHWAY_WEBHOOK_SECRET` | yes | Carrier vetting |
| `GUSTO_CLIENT_ID`, `GUSTO_CLIENT_SECRET`, `GUSTO_WEBHOOK_SECRET` | yes | Payroll |
| `PROMILES_API_KEY`, `PROMILES_WEBHOOK_SECRET` | yes | Fuel tax (IFTA) |

These are the server's own keys, used when a fleet has not saved its own. A fleet's own account with a company is kept sealed per workspace (Settings, Integrations) and wins over these.

## Tests and scripts only
| Name | What it does |
|---|---|
| `RUN_DB_INTEGRATION` | `true` runs the database tests (they write to the demo database and put everything back). |
| `RUN_SCALE` | `true` runs the scale budget tests against `demo_scale`. |
| `TRUELANE_ROOT` | Where the phone app's checkout is, for `scripts/vendor-truelane.mjs`. |
| `DRIVERS`, `TRUCKS`, `TRAILERS`, `LOADS` | How many rows `scripts/seed-scale.ts` makes. |

## Not environment variables (they live in the database, set in Settings)
The fleet's time zone (`workspaces.timezone`; Settings, Time zone), plan, company details, thresholds, bridge organisation and each driver's phone account. The browser also holds three display cookies (`desk-theme`, `desk-density`, `desk-tz`) which are preferences, never credentials.
