// VENDORED from TrueLane lib/rateCon/equipment.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * What trailer a rate confirmation asks for. Pure; shared by both ways a rate con becomes a load (the Loads bucket and Load details'
 * Import rate con), so a van, a reefer, a flatbed or a power-only load is read the same way in both.
 *
 * The reader returns the equipment as printed ("Dry Van 53'", "Van or Reefer", "Flatbed w/ tarps", "Temp controlled", "V", "26' box
 * truck"). This turns that text into the listed trailers it names, and says plainly when it cannot choose:
 *  - exactly one listed trailer named        -> that trailer;
 *  - several named ("Van or Reefer")          -> none is chosen; the trailer the truck last pulled is used only when it is one of them;
 *  - none named, short text ("Hopper")        -> Other with the text;
 *  - a negation ("no reefer", "not a flatbed") never names that trailer;
 *  - "power only" wins on its own (the trailer printed beside it is the one being pulled, not the driver's equipment).
 *
 * Nothing here decides money. A wrong trailer is a wrong label the driver can see on the sheet and fix on the load.
 */
import { OTHER_TRAILER_MAX, TRAILER_TYPES, makeOtherTrailer, trailerLabel, type TrailerType } from '@/truelane/constants/trailerData';

type Rule = { trailer: TrailerType; re: RegExp };

// Order is the order they are tried in; `options` keeps the order they APPEAR in the text.
const RULES: Rule[] = [
  { trailer: 'reefer', re: /\b(?:reefer|refrigerat\w*|temp(?:erature)?[\s-]*controlled|controlled[\s-]*temp\w*|rfr|frozen|chilled|cold[\s-]*chain)\b/i },
  { trailer: 'dry_van', re: /\bvan\b|\bdry[\s-]*freight\b|\bdv\b/i },
  { trailer: 'step_deck', re: /\bstep[\s-]*deck\b|\bdrop[\s-]*deck\b/i },
  { trailer: 'rgn', re: /\brgn\b|\blow[\s-]*boy\b|\bremovable[\s-]*goose\s*neck\b|\bdouble[\s-]*drop\b/i },
  { trailer: 'conestoga', re: /\bconestoga\b|\bcurtain[\s-]*side\w*\b|\broll[\s-]*(?:tite|tarp)\b|\brolling[\s-]*tarp\b/i },
  { trailer: 'flatbed', re: /\bflat[\s-]*bed\b|\bflat\b(?![\s-]*(?:rate|fee|pay))|\bfb\b/i },
  { trailer: 'tanker', re: /\btank(?:er)?\b(?![\s-]*(?:endorse\w*|wash|top))/i },
  { trailer: 'car_hauler', re: /\bcar[\s-]*haul\w*|\bauto[\s-]*(?:transport\w*|hauler)\b|\bcar[\s-]*carrier\b/i },
];

const POWER_ONLY = /\bpower[\s-]*only\b|\btractor[\s-]*only\b|\bpower[\s-]*unit[\s-]*only\b/i;

/** Equipment that is not a trailer on the list and that a heavy truck should not take quietly. */
const SMALL: { key: SmallEquipment; re: RegExp }[] = [
  { key: 'sprinter', re: /\bsprinter(?:[\s-]*van)?\b/i },
  { key: 'cargo_van', re: /\bcargo[\s-]*van\b|\bmini[\s-]*van\b|\bpassenger[\s-]*van\b|\bpanel[\s-]*van\b/i },
  { key: 'box_truck', re: /\bbox[\s-]*(?:truck|van)\b|\bstraight[\s-]*truck\b|\bsingle[\s-]*axle\b|\bsemi[\s-]*box\b/i },
  { key: 'hot_shot', re: /\bhot[\s-]*shot\b/i },
];

export type SmallEquipment = 'sprinter' | 'cargo_van' | 'box_truck' | 'hot_shot';

const NEGATORS = '(?:no|not|non|without|w\\/o|never|except|excluding)';

export type EquipmentReading = {
  /** Listed trailers the text names, in the order they appear, each once. */
  options: TrailerType[];
  /** "Power only" is named. */
  powerOnly: boolean;
  /** A small-vehicle or hot-shot ask: not a trailer on the list. */
  small: SmallEquipment | null;
  /** A length in feet named next to the equipment ("53'", "48 ft", "26 foot"), when there is one. */
  lengthFt: number | null;
  /** The text itself, cleaned and shortened, for an Other trailer. */
  text: string;
};

const clean = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** Remove "no reefer", "not a flatbed", "without tarps"-style negated trailer names so they never count. */
function stripNegated(text: string): string {
  let out = text;
  const all = [...RULES.map((r) => r.re.source), POWER_ONLY.source, ...SMALL.map((s) => s.re.source)];
  for (const src of all) {
    out = out.replace(new RegExp(`\\b${NEGATORS}[\\s-]+(?:a[\\s-]+|an[\\s-]+|any[\\s-]+)?(?:${src})`, 'gi'), ' ');
  }
  return out;
}

/** Single-letter load-board codes: V = van, R = reefer, F = flatbed, "V/R" = van or reefer. Only when that is the whole text. */
function boardCodes(text: string): TrailerType[] | null {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[VRF](?:[/,&+][VRF])*$/.test(t)) return null;
  const map: Record<string, TrailerType> = { V: 'dry_van', R: 'reefer', F: 'flatbed' };
  return [...new Set(t.split(/[/,&+]/).map((c) => map[c]!))];
}

export function readEquipment(text: string | null | undefined): EquipmentReading {
  const raw = clean(text ?? '');
  const empty: EquipmentReading = { options: [], powerOnly: false, small: null, lengthFt: null, text: raw };
  if (!raw) return empty;

  const codes = boardCodes(raw);
  if (codes) return { ...empty, options: codes };

  const scan = stripNegated(raw);
  const powerOnly = POWER_ONLY.test(scan);
  const small = SMALL.find((s) => s.re.test(scan))?.key ?? null;
  // "Cargo van" and "box van" are small equipment, never a dry van: take those phrases out before the trailer words are looked for.
  const noSmall = SMALL.reduce((s, x) => s.replace(new RegExp(x.re.source, 'gi'), ' '), scan);
  // "Temperature controlled van" and "reefer trailer" are one reefer, not a reefer and a van.
  const trailerText = noSmall.replace(
    /\b(temp(?:erature)?[\s-]*controlled|controlled[\s-]*temp\w*|refrigerated|reefer|frozen|chilled)[\s-]*(?:dry[\s-]*)?(?:van|trailer|truck|unit)s?\b/gi,
    ' reefer '
  );
  const hits: { trailer: TrailerType; at: number }[] = [];
  for (const { trailer, re } of RULES) {
    const m = re.exec(trailerText);
    if (m) hits.push({ trailer, at: m.index });
  }
  hits.sort((a, b) => a.at - b.at);
  const options = [...new Set(hits.map((h) => h.trailer))].filter((t) => TRAILER_TYPES.some((x) => x.value === t));
  const len = /\b(\d{2})\s*(?:'|ft\b|foot\b|feet\b|-?\s*foot\b)/i.exec(scan);
  return { options: powerOnly ? ['power_only'] : options, powerOnly, small, lengthFt: len ? Number(len[1]) : null, text: raw };
}

export type TrailerChoice = {
  /** The stored value ('dry_van', 'other:Hopper') or null when nothing can be chosen. */
  trailer: string | null;
  /** Where it came from: the rate con itself, or the trailer this truck last pulled. */
  source: 'rate_con' | 'your_truck' | null;
  /** Every listed trailer the rate con named, so the sheet can say "the rate con allows a van or a reefer". */
  options: TrailerType[];
};

/**
 * The trailer to put on the load. `preferred` is what the chosen truck last pulled (the app stores no trailer on a truck):
 * it is used only when the rate con named several and it is one of them. It never overrides a single clear answer.
 */
export function resolveTrailer(reading: EquipmentReading, preferred?: string | null): TrailerChoice {
  const { options } = reading;
  if (options.length === 1) return { trailer: options[0]!, source: 'rate_con', options };
  if (options.length > 1) {
    const p = (preferred ?? '').trim();
    if (p && (options as string[]).includes(p)) return { trailer: p, source: 'your_truck', options };
    return { trailer: null, source: null, options };
  }
  // Nothing on the list was named: Other with the text, when it is short and says something.
  const t = reading.text;
  if (!t || t.length > OTHER_TRAILER_MAX || /^(n\/?a|none|any|tbd|other|-+)$/i.test(t)) return { trailer: null, source: null, options };
  return { trailer: makeOtherTrailer(t), source: 'rate_con', options };
}

export type TruckFacts = {
  /** The vehicle category ('heavy_duty', 'cargo_van', 'box_truck', ...). */
  type: string | null;
  payloadLbs?: number | null;
  maxLengthFt?: number | null;
  /** Whether the vehicle pulls a trailer (lib/loadReadiness trailerRequiredForVehicle). */
  pullsTrailer: boolean;
};

export type FitIssue = { id: string; text: string };

const TRACTOR_ONLY: ReadonlySet<TrailerType> = new Set(['reefer', 'flatbed', 'step_deck', 'rgn', 'conestoga', 'tanker', 'car_hauler', 'power_only']);
const SMALL_NAME: Record<SmallEquipment, string> = { sprinter: 'a Sprinter', cargo_van: 'a cargo van', box_truck: 'a box truck', hot_shot: 'a hot shot' };

/**
 * Things the equipment says that the chosen truck cannot do. All are cautions: the driver knows the truck and the broker; this only
 * stops a wrong-truck or wrong-trailer pick from going through quietly.
 */
export function fitIssues(reading: EquipmentReading, trailer: string | null, truck: TruckFacts | null, weightLbs: number | null): FitIssue[] {
  if (!truck) return [];
  const out: FitIssue[] = [];
  const heavy = truck.type === 'heavy_duty' || truck.type === 'medium_duty';
  const asked = trailer && !trailer.startsWith('other:') ? (trailer as TrailerType) : null;
  if (asked && TRACTOR_ONLY.has(asked) && !truck.pullsTrailer) {
    out.push({ id: 'truck_no_trailer', text: `This rate con asks for ${asked === 'power_only' ? 'a power-only tractor' : `a ${trailerLabel(asked).toLowerCase()}`}. This truck does not pull a trailer. Check the truck you picked.` });
  }
  if (reading.small && heavy) {
    out.push({ id: 'small_load_on_tractor', text: `This rate con is for ${SMALL_NAME[reading.small]}. This truck is a ${String(truck.type).replace(/_/g, ' ')}. Check the truck you picked.` });
  }
  if (reading.lengthFt != null && reading.lengthFt >= 40 && !truck.pullsTrailer && !reading.small) {
    out.push({ id: 'long_trailer_small_truck', text: `This rate con names a ${reading.lengthFt}-foot trailer. This truck does not pull one. Check the truck you picked.` });
  }
  if (weightLbs != null && weightLbs > 0 && truck.payloadLbs != null && truck.payloadLbs > 0 && weightLbs > truck.payloadLbs) {
    out.push({ id: 'over_payload', text: `The rate con says ${Math.round(weightLbs).toLocaleString('en-US')} lbs. This truck's payload is ${Math.round(truck.payloadLbs).toLocaleString('en-US')} lbs.` });
  }
  return out;
}
