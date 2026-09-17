# Convergence Build Plan — the Desktop Projector (`LoadLeg` → `load_summary`)

> **STATUS: BUILD-READY — ratified by Chris 2026-09-17.** The §6 decisions are settled and contract v2.2
> (miles) is greenlit; the projector may be implemented against this per §7.
>
> The desktop half of the Convergence bridge. Ratified spec — implementation may proceed per §7.
> Contract of record: `TRUELANE/docs/EXTERNAL_DISPATCH_CONTRACT.md` (v2.1). Mobile read side: `TRUELANE/lib/syncPull.ts`.
> Status of the foundation (2026-09-16): Clerk Orgs live, `bridge.external_dispatch` migration applied, mobile pull proven end-to-end. **No bridge code exists in this repo yet** — this is greenfield.

## 1. Projector signatures (pure core, thin write shell)

```ts
// pure — no DB, no network, no gross. Fails the confidentiality test (§5) if a forbidden field leaks.
function projectLoadToSummary(load: LoadWithLegs, pay: AssignmentPay): LoadSummary

type AssignmentPay = { kind: 'flat' | 'cpm' | 'hourly'; rate: number };   // gap #1 — new, see §3

// thin shell — upserts the bridge row, bumps assignment_version, sets status 'draft'→'dispatched'.
async function writeDispatch(args: {
  load: LoadWithLegs; pay: AssignmentPay;
  assignedDriverClerkUserId: string;   // desktop Driver → Clerk user id (via org membership)
  orgId: string;                        // Clerk org id
}): Promise<void>
```

## 2. `LoadLeg` → `load_summary` field mapping

| `load_summary` (contract §5) | Source (Prisma `Load`/`LoadLeg`) | Note |
|---|---|---|
| `schema` | literal `2` → **`3`** if miles added (§4) | |
| `origin.address` | `pickupCity + ", " + pickupState` | strings; **no coords on desktop** (§4 coords) |
| `origin.window_earliest`/`_latest` | `pickupWindowStart` / `pickupWindowEnd` (→ ISO) | |
| `destination.address` / windows | `deliveryCity/State`, `deliveryWindowStart/End` | |
| `stops[]` | flatten `LoadLeg[]` ordered by `legIndex`; `legType` `SHUTTLE\|PTP` → `pickup`, `DELIVERY` → `delivery`; addr from leg `endCity/State`; window from `etaAt`/`arrivalAt` | milk-runs are pickup-heavy |
| `equipment.trailer_type` | map `equipmentType` (§3 table) | |
| `equipment.accessories[]` | map `equipmentAccessory` (§3 — **disjoint vocab**) | |
| `driver_pay` | **`AssignmentPay`** + computed `estimate` (§3) | authoritative rate/kind |
| `reference.broker_name` / `load_number` | `broker.name` / `loadNumber` | |
| `miles` (v2.2, §4) | `loadedMiles`, `puDeadheadMiles`, `delDeadheadMiles` | |
| `driver_docs[]` | driver-safe docs only — **never `RateConfirmation`** | Storage seam / 11m |

**OMIT — must never appear in `load_summary`:** `lineHaulRate`, `allInRevenue`, `marketRate`, `fscAmount`, `fscRateUsed`, `lineHaulPricingModel`, `tonuAmount`, `loadedRpm`, `emptyMilePct`, `rateConfirmationId` / any rate-con ref, and every cost/margin figure.

## 3. The three real decisions this spec forces

**Gap #1 — driver pay (no such field on desktop `Load` today).**
Add `Load.assignmentPay Json?` = `{ kind, rate }`, **entered by the dispatcher at assignment time** (Chris's call: flat / CPM, plus hourly since the contract allows it). Projector emits:
`driver_pay = { kind, rate, estimate }`, `estimate` = flat→`rate`; cpm→`rate × loadedMiles`; hourly→`rate × estHours` — **display only** (mobile/settlement recompute).

**Gap #2 — equipment enums.**

`EquipmentType` → `trailer_type`:

| Backhaul | mobile `trailer_type` (verified against `constants/trailerData.ts`) |
|---|---|
| `VAN_53` / `VAN_48` | `dry_van` |
| `FLATBED_OR_STEPDECK` | `flatbed` (backhaul can't distinguish step-deck) |
| `BOX_TRUCK` | **`null`** — there is NO `box_truck` in the mobile `TrailerType` enum (box trucks aren't a trailer class). |
| `OTHER` / null | `null` |

> **Enum limitation (→ future gap §9):** backhaul's `EquipmentType` only expresses van / flatbed-or-stepdeck / box / other. It **cannot express `reefer`** (or tanker, RGN, conestoga, etc.) that the mobile enum has. The projector emits `null` for anything unmapped — safe, but a reefer fleet can't be accurately described until `REEFER` is added to the desktop enum.

`EquipmentAccessory` → mobile accessorials: **the vocabularies are disjoint.** Backhaul = flatbed *securement* (`STRAPS/TARPS/CHAINS/BARS`); mobile = *dock* accessorials (`liftgate/ramp/pallet_jack`). **Nothing maps.**
- **Fallback policy:** carry `STRAPS/TARPS/CHAINS/BARS/OTHER(+equipmentOtherText)` as an informational `equipment.securement_notes` string (so a flatbed driver knows to bring straps) — **never** as a boolean dock accessorial (that would be a false requirement). Skip `NONE`.
- **Consequence to flag:** the mobile's liftgate/ramp/pallet-jack requirement **cannot be populated** from the current desktop schema — there's no field for it. Deferring the desktop field here is only about **not adding a new dependency** to the Solo path; it is *not* the whole fix. The other half is an **independent mobile bug** — the "vehicle-ownership paradox" (`FINALIZATION_AUDIT` 11a): a hired driver has no local vehicle row for a fleet-owned truck, so `useEquipmentCheck` no-ops on the vehicle side regardless of the load (and the vehicle label + pre-departure check degrade for other reasons too). That mobile bug must be fixed on its own (tracked in §9); the desktop defer does not address it. **Defer the desktop field; keep the mobile paradox flagged. Don't fake it.**

**Gap #3 — coordinates.** Projector emits **addresses only**; the mobile geocodes (it already does, for navigation). Rationale: no Mapbox dependency or geocode cost added to desktop, less coupling. *Counter-argument:* desktop geocoding would give stable coords and let the desktop own miles — rejected because we're adding an explicit `miles` block (§4) and the mobile route already resolves coords.

## 4. Contract change: v2.1 → v2.2 (add `miles`)

`load_summary.miles` is new (the mobile "0 mi" gap). Add to the contract and bump `schema` to `3`:
```jsonc
"miles": { "loaded": 512, "pickup_deadhead": 34, "delivery_deadhead": 20 }
```
→ mobile `loads.loadedMiles` / `pickupDeadheadMiles` / `returnDeadheadMiles`. Backwards-safe: absent `miles` → mobile keeps 0 and geocode-derives later.

## 5. Confidentiality schema test (must pass on every projected `load_summary`)

1. **Key denylist** — no key matching `/quoted_revenue|gross|margin|all_in|line_?haul|market_rate|fsc|rate_?con|cost|rpm|empty_mile/i` anywhere in the JSON (recursive).
2. **`driver_pay` shape** — present; keys ⊆ `{kind, rate, estimate}`.
3. **Value scan** — the load's `lineHaulRate`, `allInRevenue`, `marketRate`, `fscAmount` numeric **values** appear nowhere in the JSON (catches a leak under an innocent key).
4. **Docs** — no `driver_docs[].path` under the dispatcher-only rate-con prefix (`${org_id}/ratecons/`).

## 6. Resolved decisions (ratified by Chris — 2026-09-17)

- [x] **Trailer strings** — verified against `constants/trailerData.ts`: `VAN_*→dry_van`, `FLATBED_OR_STEPDECK→flatbed`, `BOX_TRUCK→null`, `OTHER→null` (§3). *(Corrected a draft bug: `box_truck` is not a mobile trailer type.)*
- [x] **`assignmentPay` on the `Load`** — a nullable `{ kind, rate }` field, entered by the dispatcher at assignment. One driver + one pay per dispatch; revisit a separate `Assignment` record only if per-leg relay pay becomes real.
- [x] **Liftgate/ramp/pallet-jack — DEFER the desktop field** (not on the Solo path). The mobile-side vehicle-ownership paradox is a *separate* open mobile bug (§9), not fixed by this defer.
- [x] **v2.2 `miles` block — RATIFIED** (§4). Unlocks cpm/hourly pay display + kills "0 mi"; backhaul already has the data.
- [x] **Coordinates — SETTLED: projector emits addresses, the mobile geocodes** (§3 Gap #3). No Mapbox dependency added to the desktop.

## 7. Sequence (after review)

1. Migrate this repo: Prisma → shared Supabase Postgres; add a Supabase client for bridge writes.
2. `projectLoadToSummary` (pure) + the confidentiality test (§5) — **test first**.
3. `assignmentPay` field + dispatcher assignment UI.
4. `writeDispatch` shell; wire the desktop "Dispatch" action.
5. End-to-end against the live mobile pull.

**Prerequisite, non-optional (checklist 12.1):** rotate the leaked dev Anthropic key + `replace-secrets.txt` in this repo before it points at shared prod data.

## 8. Asset inventory — what this repo gives the desktop cockpit

> ~70% of a desktop dispatch cockpit already exists here (board, ingestion, review, reference CRUD, KPI) on a
> Next.js/Prisma/Clerk/Anthropic stack that already matches TrueLane's identity layer. One theme runs through
> everything: the app is scoped **Region → Week → Lane** (the old-employer cadence). The *logic* is reusable;
> that *scoping dimension* becomes Clerk-org tenancy. Evolve in place — don't rebuild.

### ★ Crown jewels — adopt (this basically *is* the cockpit)
| Asset | Where | Why it matters |
|---|---|---|
| **Dispatch board** | `server/board.ts` (1677) + `board-detail.ts` (393) + `components/board` + `app/deliveries` + `app/dashboard` + `api/board` | Daily-planner load board: 4-color priority (past-due/today/future/done), PU/DEL status workflow, load detail, audit-logged. |
| **Rate-con ingestion (Phase 13 Magic Doc)** | `server/ingestion.ts` + `parser-engine.ts` (`rc-parser-v2`) + `server/llm/*` (provider-abstracted Anthropic) + `domain/ingestion/*` (dedup, idempotency, lifecycle) + `review.ts` (572) + `app/review` | PDF → structured load with a human review gate. The asset you'd never want to rebuild. |
| **Data model** | Prisma `Load`/`LoadLeg`/`RateConfirmation` + `Broker`/`Driver`/`Lane`/`DropLot`/`DistributionCenter`/`DirectCustomer` | The relational spine the projector (§2) flattens. |
| **Reference-data CRUD** | `server/reference.ts` (1359) + `app/reference/*` + `api/reference/*` | Brokers, drivers, lanes, drop-lots, direct-customers, booking-plan — cockpit entity management. |
| **App chassis** | `app/(auth)` + `middleware.ts` + `components/{auth,shell,ui,icons}` | Already on **Clerk = TrueLane's identity**. The frame to hang everything on. |

### ◐ Adopt but re-scope / re-plumb (the work)
| Asset | Where | Change needed |
|---|---|---|
| **KPI / reporting** | `kpi-dashboard.ts` (1125) + `kpi-*` + `components/kpi` + `api/kpi/export` (csv/pdf/email) | = Phase 12 cost-recovery/variance reporting; heavier, employer-shaped. |
| **DAT market-rate** | `server/dat/*` + `MarketRateQuote`/`MarketVarianceEntry` + `api/market-rate` | Desktop benchmarking; pairs with mobile Market Variance. Keep if DAT is wanted. |
| **FSC + rules** | `fsc.ts` (`FuelSurchargeIndex`), `operational-rules.ts` (`OperationalRule`) | FSC reusable; rules engine → natural home for the 12.3 safety gates. |
| **Storage / queue transport** | `upload-storage.ts` + `queue*.ts` on **AWS S3/SQS** | Swap to **Supabase Storage** (gap #5). Ingestion *logic* stays; only transport changes. |

### ✗ Cut or defer
| Asset | Where | Why |
|---|---|---|
| **Chat copilot** | `server/copilot/*` + `api/copilot` + `components/copilot` | Plan removes it (returns later as a paid AI add-on). |
| **Region/Week cadence** | `Region`/`WeekSnapshot`/`RegionConfig`/`UserRegionRole`, `snapshots.ts`, `lane-week-*`, `runInRegionScope`/`withRegionScope` | Fused to the old employer's business. **Re-scoping region/week → Clerk-org tenancy is the largest single adaptation** — every board/ingestion query carries it. |

**Net remaining work to turn this into the TrueLane desktop cockpit:** (a) re-scope region/week → Clerk-org, (b) Prisma → shared Supabase Postgres + S3→Supabase Storage, (c) add the bridge projector (§1–§5) + the driver-pay step (§3), (d) delete the copilot.

## 9. Documented future gaps (not projector blockers)

- **Backhaul `EquipmentType` needs `REEFER`** (and ideally tanker / RGN / etc.). Reefers are a large share of freight; the current desktop enum can't describe a refrigerated fleet, so the projector emits `null` for it. Add `REEFER` to the desktop enum before a reefer fleet is a prospect. (See §3 Gap #2.)
- **Mobile vehicle-ownership paradox** (`FINALIZATION_AUDIT` 11a) — a hired driver's local DB has no vehicle row for a fleet-owned truck, so the equipment-drift check no-ops on the vehicle side and the vehicle label degrades. **Mobile-side bug, independent of this repo**; fix by pulling the assigned load's vehicle or stamping specs onto the load, before the accessorial pre-departure check can mean anything for bridge loads.
