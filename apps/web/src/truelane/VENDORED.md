# Vendored TrueLane domain code

Source: TrueLane checkout at commit `a3a9c0f422b753c81775bee1c159d66832b4db38`.
Refresh with `node scripts/vendor-truelane.mjs` (set `TRUELANE_ROOT` if the checkout is elsewhere), then run `npm test`.
These are the same modules the phone uses for the break-even floor, the verdict, market variance, load economics, invoices and analytics.
The golden tests in `tests/truelane-domain.test.ts` pin the figures on the TrueLane site ($650 over 545 mi = $1.19/mi, over 308 mi = $2.11/mi).

## Files
- `lib/analytics.ts`
- `lib/calculate/acceptGate.ts`
- `lib/calculate/afterDelivery.ts`
- `lib/calculate/emptyMiles.ts`
- `lib/costProfileHero.ts`
- `lib/costProfileSnapshot.ts`
- `lib/domain/calculators.ts`
- `lib/domain/calendarDays.ts`
- `lib/domain/completedAt.ts`
- `lib/domain/costArchetype.ts`
- `lib/domain/detention.ts`
- `lib/domain/evaluateLoad.ts`
- `lib/domain/fieldRelevance.ts`
- `lib/domain/hos.ts`
- `lib/domain/loadEconomics.ts`
- `lib/domain/marketVariance.ts`
- `lib/domain/marketVerdict.ts`
- `lib/domain/quotedMiles.ts`
- `lib/domain/tripHours.ts`
- `lib/formatNumbers.ts`
- `lib/fuelPriceForRates.ts`
- `lib/fuelSurcharge.ts`
- `lib/insuranceFields.ts`
- `lib/invoice.ts`
- `lib/rateCon/equipment.ts`
- `lib/rateCon/types.ts`
- `constants/trailerData.ts`
- `constants/vehicleData.ts`
- `utils/calculateHelpers.ts`
- `supabase/functions/rate-con-extract/core.ts` (as `rate-con/core.ts`)
