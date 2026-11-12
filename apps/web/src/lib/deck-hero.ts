/**
 * What leads the load deck (the strip above the tabs, in the drawer and on the full page).
 *
 * One hero. A load with a floor leads with its margin against that floor: what it pays a mile (every mile counted) minus the floor. A load with no floor yet (not judged: no truck chosen, no cost profile)
 * has nothing to measure against, so it leads with what it pays instead of going blank. A TONU leads with the fee earned. Gross pay always stays visible: as the hero when nothing is judged, otherwise as the
 * first figure of the summary line beside it. PURE: no imports, so the test runs without the page.
 */
export type DeckLead = "margin" | "gross" | "tonu";
export type DeckTone = "ok" | "warn" | "bad" | "";

export type DeckHero = {
  /** What the big figure is. */
  lead: DeckLead;
  /** Dollars a mile over (positive) or under (negative) the floor; null when there is no floor to measure against. */
  margin: number | null;
  hasFloor: boolean;
  /** Square colour beside the hero: the verdict's own tone when it has one, else the sign of the margin, else none. */
  tone: DeckTone;
  /** The summary line leads with gross pay only when the hero is not already the gross. */
  grossInLine: boolean;
};

export function deckHero(i: { tonu: boolean; allIn: number | null; floor: number; verdictTone?: string | null }): DeckHero {
  const hasFloor = i.allIn != null && Number.isFinite(i.allIn) && i.floor > 0;
  const margin = hasFloor ? (i.allIn as number) - i.floor : null;
  if (i.tonu) return { lead: "tonu", margin: null, hasFloor, tone: "", grossInLine: false };
  const v = i.verdictTone === "ok" || i.verdictTone === "warn" || i.verdictTone === "bad" ? i.verdictTone : "";
  const tone: DeckTone = v || (margin == null ? "" : margin >= 0 ? "ok" : "bad");
  return { lead: margin == null ? "gross" : "margin", margin, hasFloor, tone, grossInLine: margin != null };
}
