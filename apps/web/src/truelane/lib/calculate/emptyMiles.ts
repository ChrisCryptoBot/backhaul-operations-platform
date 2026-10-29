// VENDORED from TrueLane lib/calculate/emptyMiles.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Empty miles (pickup + return deadhead) on the Rate Calculator — pure state rules.
 *
 * Model: each leg has a CHOICE (where the truck starts / goes after delivery) and, for the
 * home choice, a SOURCE (auto-filled from the vehicle's home base, or typed by the driver).
 *  - `returnTo` is the single source of truth for backhaul: `isBackhaul === (returnTo === 'nextLoad')`.
 *  - Auto-fill only ever writes a leg whose choice is 'home' AND whose source is 'auto'.
 *    'elsewhere' legs and hand-typed numbers are never overwritten.
 */
import type { SetStateAction } from 'react';
import { toNum } from '@/truelane/utils/calculateHelpers';

export type PickupFrom = 'home' | 'elsewhere';
export type ReturnTo = 'home' | 'nextLoad' | 'elsewhere';
export type DeadheadSource = 'auto' | 'manual';
export type DeadheadLeg = 'pickup' | 'return';

export type EmptyMilesChoiceState = {
  pickupFrom: PickupFrom;
  returnTo: ReturnTo;
  pickupDeadheadSource: DeadheadSource;
  returnDeadheadSource: DeadheadSource;
};

/** A fresh form: home → home, both legs ready for auto-fill. */
export const EMPTY_MILES_DEFAULTS: EmptyMilesChoiceState = {
  pickupFrom: 'home',
  returnTo: 'home',
  pickupDeadheadSource: 'auto',
  returnDeadheadSource: 'auto',
};

/** True when auto-fill may write this leg (choice is home AND the number wasn't hand-typed). */
export function canAutoFillLeg(leg: DeadheadLeg, s: EmptyMilesChoiceState): boolean {
  if (leg === 'pickup') return s.pickupFrom === 'home' && s.pickupDeadheadSource === 'auto';
  return s.returnTo === 'home' && s.returnDeadheadSource === 'auto';
}

/**
 * Maps a legacy `setIsBackhaul(action)` call (Load editor toggle, hydration) onto `returnTo`.
 * Turning backhaul off from 'nextLoad' lands on 'home'; turning it off from any other choice is a no-op.
 */
export function applyBackhaulAction(prev: ReturnTo, action: SetStateAction<boolean>): ReturnTo {
  const current = prev === 'nextLoad';
  const next = typeof action === 'function' ? action(current) : action;
  if (next) return 'nextLoad';
  return prev === 'nextLoad' ? 'home' : prev;
}

/**
 * Saved load → choices. The load stores only the numbers + is_backhaul, so the choice is inferred:
 *  - backhaul → 'nextLoad'; anything else → 'home'.
 *  - a saved number > 0 is treated as the driver's (manual) so reopening never overwrites it;
 *    0 / blank stays auto so a fresh lookup can fill it.
 */
export function hydrateEmptyMilesChoices(saved: {
  isBackhaul: boolean;
  pickupDeadheadMiles: number | string | null | undefined;
  returnDeadheadMiles: number | string | null | undefined;
}): EmptyMilesChoiceState {
  const pickup = toNum(String(saved.pickupDeadheadMiles ?? ''));
  const ret = toNum(String(saved.returnDeadheadMiles ?? ''));
  return {
    pickupFrom: 'home',
    returnTo: saved.isBackhaul ? 'nextLoad' : 'home',
    pickupDeadheadSource: pickup > 0 ? 'manual' : 'auto',
    returnDeadheadSource: saved.isBackhaul ? 'auto' : ret > 0 ? 'manual' : 'auto',
  };
}

/** Writes a full choice state onto the form (hydration). */
export function applyEmptyMilesChoices(
  form: {
    setPickupFrom: (v: PickupFrom) => void;
    setReturnTo: (v: ReturnTo) => void;
    setPickupDeadheadSource: (v: DeadheadSource) => void;
    setReturnDeadheadSource: (v: DeadheadSource) => void;
  },
  s: EmptyMilesChoiceState
): void {
  form.setPickupFrom(s.pickupFrom);
  form.setReturnTo(s.returnTo);
  form.setPickupDeadheadSource(s.pickupDeadheadSource);
  form.setReturnDeadheadSource(s.returnDeadheadSource);
}

/** Source for a keystroke on a home leg: clearing the field hands it back to auto-fill. */
export function sourceForTypedMiles(v: string): DeadheadSource {
  return v.trim() === '' ? 'auto' : 'manual';
}

/** Return-leg miles that count in the math (a load back covers the return leg). */
export function effectiveReturnMiles(returnTo: ReturnTo, returnDeadheadMiles: string): number {
  return returnTo === 'nextLoad' ? 0 : toNum(returnDeadheadMiles);
}

export function pickupLineLabel(pickupFrom: PickupFrom): string {
  return pickupFrom === 'home' ? 'Home → pickup' : 'Where you are → pickup';
}

export function returnLineLabel(returnTo: ReturnTo): string {
  if (returnTo === 'nextLoad') return 'Delivery → next load';
  if (returnTo === 'elsewhere') return 'Delivery → next stop';
  return 'Delivery → home';
}

export type EmptyMilesHintKind = 'noHomeBase' | 'fillFailed' | 'typed' | 'filled' | 'waiting';

/**
 * The single status line under the empty-miles block. Priority:
 * no home base (when a home leg needs it) → failed fill → all typed → filled → waiting for addresses.
 */
export function emptyMilesHint(p: {
  hasHomeBase: boolean;
  fillFailed: boolean;
  state: EmptyMilesChoiceState;
  pickupDeadheadMiles: string;
  returnDeadheadMiles: string;
}): { kind: EmptyMilesHintKind; text: string } {
  const { state } = p;
  const homeLegs: DeadheadLeg[] = [];
  if (state.pickupFrom === 'home') homeLegs.push('pickup');
  if (state.returnTo === 'home') homeLegs.push('return');
  const autoHomeLegs = homeLegs.filter((leg) => canAutoFillLeg(leg, state));

  if (autoHomeLegs.length > 0 && !p.hasHomeBase) {
    return { kind: 'noHomeBase', text: 'Set your home base to fill these automatically →' };
  }
  if (autoHomeLegs.length > 0 && p.fillFailed) {
    return { kind: 'fillFailed', text: "Couldn't figure miles from home — type them in." };
  }
  if (autoHomeLegs.length === 0) {
    return { kind: 'typed', text: 'Using the miles you typed.' };
  }
  const value = (leg: DeadheadLeg) => (leg === 'pickup' ? p.pickupDeadheadMiles : p.returnDeadheadMiles);
  const allFilled = autoHomeLegs.every((leg) => value(leg).trim() !== '');
  if (allFilled) {
    return { kind: 'filled', text: 'Filled from your home base — tap a number to change it.' };
  }
  return { kind: 'waiting', text: 'Pick your pickup and delivery addresses to fill these from home.' };
}
