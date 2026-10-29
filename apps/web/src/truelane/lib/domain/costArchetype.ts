// VENDORED from TrueLane lib/domain/costArchetype.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Cost-profile archetype — the owner-operator's business structure, which drives the LABOR cost model
 * (see `computeTripLaborCPM`). Distinct from the fleet identity roles in `fleetRoles.ts` (those come
 * from Clerk `publicMetadata.role` and are gated by `fleetMode`); this is a per-profile cost field.
 *
 * v1 has three archetypes, each with a genuinely different cost model:
 *   - `solo_owner`   — owner drives; no labor line (self-employment tax is a separate, display-only reserve).
 *   - `leased_on`    — leased to a carrier; a user-entered carrier cut % changes the gross-up math.
 *   - `hired_driver` — owner pays a driver; the driver's wage × hours × (1 + payroll burden) enters break-even.
 *
 * The retired `team` and `fleet` labels computed the SAME number as `hired_driver` (identical labor
 * burden) — three labels, one behavior — so they're dropped from the picker and migrated to
 * `hired_driver`. `fleet` (a blended multi-truck cost model) is Phase-2 territory, not v1 solo.
 */

export type CostArchetype = 'solo_owner' | 'leased_on' | 'hired_driver';

/**
 * The selectable archetypes + their user-facing labels and a one-line explainer (order = picker order).
 * Labels are single-token — the wizard is already in an owner-op cost profile, so repeating
 * "owner-operator" on every option just made the picker wrap. The `blurb` renders under the picker,
 * keyed to the selection, so a first-timer knows what "Leased-on" actually means for their costs.
 * ("Owner + driver", not "hired driver": the fields under it are about the driver you PAY; the stored
 * enum value stays `hired_driver` — label-only.)
 */
export const COST_ARCHETYPES: { value: CostArchetype; label: string; blurb: string }[] = [
  { value: 'solo_owner', label: 'Solo', blurb: 'You drive your own truck under your own authority.' },
  { value: 'leased_on', label: 'Leased-on', blurb: "You drive under another carrier's authority; they take a cut." },
  { value: 'hired_driver', label: 'Owner + driver', blurb: 'You own the truck and pay someone else to drive it.' },
];

/**
 * Migrate any stored / legacy archetype string to a current selectable value.
 * `team` and `fleet` are retired but computed employed-driver labor identically to `hired_driver`, so
 * they map there — **never to `solo_owner`**, which would silently zero that labor cost and understate
 * break-even. Unknown / absent → `solo_owner` (the default). Pure; safe to call on every profile load.
 */
export function normalizeArchetype(raw: string | null | undefined): CostArchetype {
  if (raw === 'leased_on') return 'leased_on';
  if (raw === 'hired_driver' || raw === 'team' || raw === 'fleet') return 'hired_driver';
  return 'solo_owner';
}

/**
 * The carrier's cut (0–1) that applies to this setup: only a leased-on driver pays one. The wizard
 * keeps the stored value when a truck switches to solo or owner + driver (so switching back restores
 * it), so every reader goes through here — a leftover 20% must never come off a solo driver's pay.
 */
export function effectiveCarrierCutPct(archetype: string | null | undefined, carrierCutPct: number | null | undefined): number {
  if (normalizeArchetype(archetype) !== 'leased_on') return 0;
  return typeof carrierCutPct === 'number' && Number.isFinite(carrierCutPct) ? Math.max(0, Math.min(carrierCutPct, 1)) : 0;
}

/** Leased-on: "Does your carrier take its cut from fuel surcharge?" (V-04). Null = not answered yet. */
export type FscCutAnswer = 'yes' | 'no' | 'not_sure';

/** The question and its help, word for word — the Cost profile and Calculate's one-time prompt share them. */
export const FSC_CUT_QUESTION = 'Does your carrier take its cut from fuel surcharge?';
export const FSC_CUT_HELP =
  'Check a settlement statement. If fuel surcharge is its own line paid to you in full, choose No.';

/** Any stored value → a known answer, or null (unanswered / unknown). */
export function normalizeFscCutAnswer(v: string | null | undefined): FscCutAnswer | null {
  return v === 'yes' || v === 'no' || v === 'not_sure' ? v : null;
}

/**
 * Whether the cut comes off fuel surcharge. Only a clear "No" excludes it: Yes, Not sure and unanswered
 * all take the cut from FSC — the conservative case, which never overstates net pay.
 */
export function fscCutAppliesFor(answer: string | null | undefined): boolean {
  return normalizeFscCutAnswer(answer) !== 'no';
}
