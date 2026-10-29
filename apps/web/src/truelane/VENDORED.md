# Vendored TrueLane domain code

Source: TrueLane checkout at commit `e7c880666705254e7089a1771c52027cb186e397`.
Refresh with `node scripts/vendor-truelane.mjs` (set `TRUELANE_ROOT` if the checkout is elsewhere), then run `npm test`.
These are the same modules the phone uses for the break-even floor, the verdict, market variance, load economics, invoices and analytics.
The golden tests in `tests/truelane-domain.test.ts` pin the figures on the TrueLane site ($650 over 545 mi = $1.19/mi, over 308 mi = $2.11/mi).

## Files
- `lib/analytics.ts`
- `lib/calculate/afterDelivery.ts`
- `lib/calculate/emptyMiles.ts`
- `lib/domain/calculators.ts`
- `lib/domain/calendarDays.ts`
- `lib/domain/completedAt.ts`
- `lib/domain/costArchetype.ts`
- `lib/domain/detention.ts`
- `lib/domain/evaluateLoad.ts`
- `lib/domain/hos.ts`
- `lib/domain/loadEconomics.ts`
- `lib/domain/marketVariance.ts`
- `lib/domain/marketVerdict.ts`
- `lib/domain/quotedMiles.ts`
- `lib/domain/tripHours.ts`
- `lib/formatNumbers.ts`
- `lib/fuelSurcharge.ts`
- `lib/invoice.ts`
- `lib/rateCon/equipment.ts`
- `lib/rateCon/types.ts`
- `constants/trailerData.ts`
- `utils/calculateHelpers.ts`
- `supabase/functions/rate-con-extract/core.ts` (as `rate-con/core.ts`)
