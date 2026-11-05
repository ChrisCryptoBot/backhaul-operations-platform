# Telematics radar, idle waste and trailer dwell

Built locally on `demo/truelane-dispatch`. Desk only: nothing is sent to the phone or the bridge. Production migration `20261128000000_telematics_radar` is Chris's to apply. The partner-facing description of the same data is `docs/PARTNER_INTEGRATION_SPEC.md`.

## What it is

The ELD's positions made visible and made into money, without a map vendor, a tile server or any hardware: a radar map, the cost of engines left idling, and the cost of trailers left sitting. It rides the existing `eld` capability (the partner contract is vendored and unchanged), so a carrier's own Motive-style account is the only source.

## Screens

- **Radar map** (`/fleet/map`, Fleet rail, code `MP`): every tractor and trailer with a position on a map the desk draws itself (MapLibre GL). A telemetry rail on the right (`Total units`, `Moving under load`, `Idling`, `Parked`, `Dropped trailers`, how old the picture is, a Read ELD now button for a dispatcher), a key, and an inspector for whatever is clicked. A small still version heads the Trucks and Trailers lists and links through. The map polls the desk's own data route every 30 seconds; positions are as of the last ELD read (the cron asks every 15 minutes).
- **Marks** (square glyphs, no circles): a tractor is gold (`--label`) moving under an assigned load, amber (`--warn`) standing with the engine on, ink moving with no load, dim parked; the arrow points along the heading. A trailer is a square, heavy when dropped, light when hooked, a green dot when loaded, amber when it is a dwell alert.
- **Basemap**: bundled, offline. Lower-48 state outlines (`src/lib/basemap/us-states.ts`, generated from the public-domain Census shapes in the `us-atlas` package by `scripts/build-basemap.mjs`, thinned to about a mile) and twelve authored interstate corridors (`src/lib/basemap/interstates.ts`). No tile server, no key, no network, so it works in the demo and in tests. Colours are read from the live CSS tokens (night and day), so the canvas is the desk's own black and not the `#0B0E14` of the brief. Pointing it at a street-level tile source later is a change to the style in `radar-map.tsx`.
- **Trucks, Idling now**: `IDLING (Stationary 3h 14m) · Burned: 3.2 gal · Cash Lost: −$12.80`. Gallons are the idle hours at a fixed 1.0 gallon an hour (`IDLE_GAL_PER_HOUR`, a stated figure, not a measurement); the price is the truck's own cost-profile fuel price, else the fleet's average, and with no price the cash is left out, never guessed.
- **Trailers, Dwell** (and the trailer page): `SITTING 4.2 DAYS · Dwell Alert: Exceeds 48h free time · Detention Owed: +$165.00`. The clock starts when the trailer is unhooked (`unhookedAt`); the trailer's position is where its tractor left it. Days past the free time are charged at the day rate by the hour.
- **Load, Where it is** (fifth tab, key 5): the lane from pickup to delivery, the truck's breadcrumb and marker, and `68 MPH · I-40 E · 142 miles to destination · ETA 14:15 CT · ON SCHEDULE`. A truck inside a mile of a stop gets `✔ GEOFENCE: AT RECEIVER FACILITY (14:12 CT)` with the time of the first fix inside. It only shows: it writes no arrival on the stop, because detention and money depend on what a person or the driver's phone says.

## The dwell figure is a person's call

Industry-average defaults (48 hours free, $75 a day) are only the start. The company sets its own in **Settings, Rules, Trailer dwell**, and on any one trailer a **dispatcher or a billing person** (the `dispatch` or the `bill` capability; so accounting, a dispatcher with "Can also bill", and an admin) can type the **rate a day**, type the **billable days**, or **waive the fee entirely**, with a note. Typed figures show in the typed colour (`--typed`, blue) with who typed them and the company figure beside; a waived fee reads `Detention WAIVED (was +$165.00)`. A "Back to the company figure" button clears it. A typed figure stands for that stay: later recomputation only changes the computed figure beside it, and hooking the trailer again clears it (the audit trail keeps what it was). Every change is audited (`dwell_adjusted`, `dwell_waived`, `dwell_reset`) with the figures before and after and who made it. Viewer and Driver manager see it read-only. The figure is a recorded amount; it is not posted to an invoice by this work.

## One-click onboarding

An admin who enters a `sandbox_` Motive key in Settings, Integrations has the fleet it lists added as trucks (VIN, unit, make, model) and drivers (name, licence number, hours clocks, a driver code, paired with their truck), then the desk reads where they all are, so the radar lights up at once ("Imported 8 trucks and 8 drivers; 8 on the map"). Nothing the desk already has is changed (a truck or driver is matched by the ELD's id, then VIN, then name), the plan's limits hold (it imports what fits and says how many were left out), and a second run adds nothing. "Import fleet from the ELD" re-runs it. A real (non-test) key behaves as before: Connect is a person's step, and the live call is still not written.

## The simulator

The Motive simulator is no longer a hub-hopper. A tractor on an open load travels its lane (pickup to delivery) by the load's clock; a load already under way is somewhere along it whatever its window says; a tractor on no load parks at its home base, with the engine off or idling in stable six-hour spells; the company's own eight-truck fleet runs lanes between freight hubs. Deterministic per tractor and quarter hour, no network, and the read answers for the moment it was asked about (`asOf`), so a re-read of the same moment keeps the same fix.

## Data

`vehicles` (VIN, speed, heading, engine state, idle hours today, idle since), `trailers` (position, hooked and unhooked times, the dwell override), `drivers` (licence number), `workspaces` (`dwell_free_hours`, `dwell_per_day_rate`), and `vehicle_pings`: a week of position fixes per tractor (unique per tractor and instant), purged by the cron heartbeat. The pure rules are `lib/telematics.ts`, `lib/radar.ts` and `lib/geo-line.ts`.

## Verified, not built, open

Tests: `tests/telematics.test.ts`, `tests/telematics-adapter.test.ts`, `tests/radar-rules.test.ts`, `tests/partner-spec.test.ts`, `tests/integration/telematics.integration.test.ts`. Not built: any live ELD call (Motive's included), Samsara, a telematics webhook event, a scheduler for the cron route, trailer tag hardware, an invoice line for dwell, street-level tiles. Spireon is not in the partner contract.
