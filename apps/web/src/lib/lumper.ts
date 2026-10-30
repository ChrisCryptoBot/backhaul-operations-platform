/**
 * Whether a load is likely to need a lumper, read from a rate confirmation before the load is taken. A lumper is the receiver's unloading
 * crew, paid by the load; some rate cons say so, many do not, and grocery and food freight expects one either way. Three things are read:
 * the words (a lumper is stated), the commodity, and the names of the stops. Pure. The phone's own copy of this rule is
 * lib/rateCon/requirementSignals.ts in the app; the two are kept to the same words by hand.
 */
export type LumperInput = {
  commodity: string | null;
  /** Every free-text field the document printed: notes, dock and detention terms, accessorial names, stop instructions. */
  text: string[];
  stops: Array<{ stopType: string; facilityName: string | null }>;
};
export type LumperFlag = { kind: "stated" | "likely"; text: string };

const COMMODITY = /\b(?:produce|groceries|grocery|fresh\s+(?:fruits?|vegetables?|food)|fruits?|vegetables?|dairy|meats?|poultry|seafood|frozen\s+foods?|food\s*products?|foodstuffs?|beverages?|perishables?)\b/i;

const FACILITY = new RegExp(
  [
    "kroger", "safeway", "albertsons?", "publix", "h-?e-?b", "aldi", "costco", "sysco", "us\\s*foods", "performance\\s+food", "pfg",
    "c\\s*&\\s*s\\s+wholesale", "spartan\\s*nash", "unfi", "united\\s+natural", "whole\\s+foods", "wegmans", "meijer", "food\\s+lion",
    "stop\\s*&\\s*shop", "winn[\\s-]*dixie", "sprouts", "trader\\s+joe", "ahold", "raley", "save\\s+mart", "ingles", "hy-?vee",
    "shop\\s*rite", "wakefern", "giant\\s+eagle", "fresh\\s+market", "supermarkets?", "groceries", "grocery", "produce", "foods?"
  ].join("|"),
  "i"
);

const NEGATOR = /\b(?:no|not|non|without|w\/o|never|n\/a|isn'?t|aren'?t|unnecessary)\b/i;

/** A mention of a lumper that is not negated ("no lumper", "lumper not required"). */
function statedLumper(text: string): boolean {
  const g = /\blumpers?\b|\blumping\b/gi;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 28), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    const negBefore = NEGATOR.test(before.split(/[.;\n]/).pop() ?? "");
    const negAfter = /^\W*(?:is\s+|are\s+)?(?:not|n't|no)\b/i.test(after);
    if (!negBefore && !negAfter) return true;
  }
  return false;
}

export function lumperFlag(input: LumperInput): LumperFlag | null {
  if (statedLumper(input.text.filter((t) => t.trim() !== "").join(" \n "))) {
    return { kind: "stated", text: "The document mentions a lumper. Find out who pays it, and get that in writing, before you take the load." };
  }
  const commodity = COMMODITY.exec(input.commodity ?? "")?.[0];
  const place = input.stops.find((s) => FACILITY.test(s.facilityName ?? ""));
  if (!commodity && !place) return null;
  const why = [
    commodity ? `${commodity.toLowerCase()} freight` : null,
    place ? `${place.stopType === "delivery" ? "receiver" : "shipper"} ${place.facilityName}` : null
  ]
    .filter(Boolean)
    .join(", ");
  return { kind: "likely", text: `A lumper is likely (${why}). The document does not say. Ask who pays it before you take the load.` };
}
