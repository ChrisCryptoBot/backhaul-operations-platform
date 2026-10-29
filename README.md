# Dispatch desk

A dispatcher's web desk built on **TrueLane's data model**: the same loads, stops, trucks and cost profiles the TrueLane phone app
keeps, plus the dispatcher's own layer (drivers and assignments). It uses TrueLane's own math for every number, so a verdict on
the desk is the verdict the driver would see on the Calculate screen.

> **Demo.** Every name, broker, load and reference number in this repository is invented. It has no connection to any real
> company's data, and it runs against a throwaway database.

## What it does

- **Loads** — every load with its verdict on the truck's own cost, and a "count every mile" view: the same offer on 545 miles
  (way home empty) against 308 miles (a load covers the way back).
- **Dispatch** — assign a driver with flat, per-mile or hourly pay, send it, record the driver's answer. The driver is sent only
  where to go, when, the numbers the dock will ask for and how they are paid: never the rate, the gross or any cost
  (`src/server/tl/projector.ts` fails loudly if one leaks).
- **Rate confirmations** — read a document, check the draft, confirm, save. A rate confirmation never shows a verdict.
- **KPI dashboard** — revenue by week and month, empty-mile share, the pipeline, open loads against cost, market variance,
  per-driver totals and money owed, computed from the loads.
- **Drivers, trucks, invoices** — compliance dates that block an assignment, each truck's break-even floor, invoice and payment
  aging.

## Where the numbers come from

`apps/web/src/truelane/` holds TrueLane's pure money, miles and verdict modules, copied by `apps/web/scripts/vendor-truelane.mjs`
with the source commit in `VENDORED.md`. Nothing there is edited by hand. `tests/truelane-domain.test.ts` pins the figures on the
TrueLane site ($650 over 545.2 mi is $1.19/mi; over 308.2 mi it is $2.11/mi).

## Stack

Next.js 14 (App Router, server components and actions) · TypeScript · Prisma + PostgreSQL · Anthropic API (optional, only to read
your own rate confirmation files).

## Running it

You need a throwaway Postgres. With Docker:

```
docker run -d --name backhaul-demo-pg -e POSTGRES_PASSWORD=demo -e POSTGRES_USER=demo -e POSTGRES_DB=demo -p 54330:5432 postgres:16
cp .env.example apps/web/.env.local
npm install
npx prisma migrate deploy
npm run seed --workspace apps/web      # 3 trucks, 4 drivers, 42 loads, all invented
npm run dev                            # http://localhost:3000
npm test                               # unit tests
npm run test:db --workspace apps/web   # the dispatcher flow against the database (set RUN_DB_INTEGRATION=true)
```

See [`docs/DEMO_REBUILD.md`](docs/DEMO_REBUILD.md) for how the rebuild was done and
[`docs/CONVERGENCE_BUILD_PLAN.md`](docs/CONVERGENCE_BUILD_PLAN.md) for the bridge contract this follows.
