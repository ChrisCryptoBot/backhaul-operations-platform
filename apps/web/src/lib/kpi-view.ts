/**
 * Small pure helpers the KPI charts share: change against the previous period, histogram bins, and sparkline geometry.
 * The charts are plain SVG and CSS rendered on the server, so everything they need is computed here and unit-tested.
 */
export type DeltaKind = "pct" | "pts";
export type Delta = { tone: "good" | "bad" | "flat"; glyph: "▲" | "▼" | "–"; text: string };

const MINUS = "−";

/**
 * How `current` moved against `previous`. "pct" is the relative change (revenue, miles); "pts" is percentage points between
 * two shares given as fractions (empty miles). The colour is the judgement and the glyph is the direction, so for a measure
 * where lower is better (empty miles, days to pay) a fall is a green ▼. Null when there is nothing to compare.
 */
export function deltaOf(current: number | null | undefined, previous: number | null | undefined, o: { kind: DeltaKind; lowerIsBetter?: boolean; flatBelow?: number }): Delta | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  let change: number;
  if (o.kind === "pts") change = (current - previous) * 100;
  else {
    if (previous === 0) return null;
    change = ((current - previous) / Math.abs(previous)) * 100;
  }
  const flat = Math.abs(change) < (o.flatBelow ?? 0.5);
  const up = change > 0;
  const good = o.lowerIsBetter ? !up : up;
  const mag = Math.abs(change).toFixed(1);
  const text = flat ? (o.kind === "pts" ? "no change" : "flat") : `${up ? "+" : MINUS}${mag}${o.kind === "pts" ? " pts" : "%"}`;
  return { tone: flat ? "flat" : good ? "good" : "bad", glyph: flat ? "–" : up ? "▲" : "▼", text };
}

/** Relative change as a fraction, or null when it cannot be told (no earlier value, or it was zero). */
export function changeFraction(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type VarianceBin = { label: string; lo: number; hi: number; tone: "bad" | "warn" | "ok" };

/** Rate against the market, as fractions: under -20%, -20 to -10, -10 to -5, -5 to 0, 0 to +5, +5 to +10, +10 to +20, over +20. */
export const VARIANCE_BINS: VarianceBin[] = [
  { label: `under ${MINUS}20%`, lo: -Infinity, hi: -0.2, tone: "bad" },
  { label: `${MINUS}20 to ${MINUS}10`, lo: -0.2, hi: -0.1, tone: "bad" },
  { label: `${MINUS}10 to ${MINUS}5`, lo: -0.1, hi: -0.05, tone: "warn" },
  { label: `${MINUS}5 to 0`, lo: -0.05, hi: 0, tone: "warn" },
  { label: "0 to +5", lo: 0, hi: 0.05, tone: "ok" },
  { label: "+5 to +10", lo: 0.05, hi: 0.1, tone: "ok" },
  { label: "+10 to +20", lo: 0.1, hi: 0.2, tone: "ok" },
  { label: "over +20%", lo: 0.2, hi: Infinity, tone: "ok" }
];

/** Counts each value into its bin; a load with no market rate is not guessed into one, it is counted as unverified. */
export function binVariances(values: Array<number | null | undefined>): { bins: Array<VarianceBin & { count: number }>; unverified: number; total: number } {
  const bins = VARIANCE_BINS.map((b) => ({ ...b, count: 0 }));
  let unverified = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) {
      unverified += 1;
      continue;
    }
    const bin = bins.find((b) => v >= b.lo && v < b.hi);
    if (bin) bin.count += 1;
  }
  return { bins, unverified, total: values.length };
}

export type Spark = { d: string; last: { x: number; y: number } | null; min: number | null; max: number | null };

function sparkScale(values: Array<number | null>, w: number, h: number, pad: number) {
  const real = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (real.length === 0) return null;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min;
  const x = (i: number) => (values.length === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (values.length - 1));
  const y = (v: number) => (span === 0 ? h / 2 : h - pad - ((v - min) / span) * (h - 2 * pad));
  return { min, max, x, y };
}

/** Sparkline geometry in a w x h box. A null breaks the line; a flat series sits in the middle; one point is just a dot. */
export function sparkPath(values: Array<number | null>, w: number, h: number, pad = 3): Spark {
  const sc = sparkScale(values, w, h, pad);
  if (!sc) return { d: "", last: null, min: null, max: null };
  const { min, max, x, y } = sc;
  let d = "";
  let pen = false;
  let last: Spark["last"] = null;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    pen = true;
    last = { x: x(i), y: y(v) };
  });
  return { d: d.trim(), last, min, max };
}

/** Where every point of the same sparkline sits (null for a gap), so a hover can land a marker on the week under the pointer. */
export function sparkPoints(values: Array<number | null>, w: number, h: number, pad = 3): Array<{ x: number; y: number } | null> {
  const sc = sparkScale(values, w, h, pad);
  return values.map((v, i) => (!sc || v == null || !Number.isFinite(v) ? null : { x: sc.x(i), y: sc.y(v) }));
}

/** Sum of a slice, for "the last four weeks against the four before". */
export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export type WeekSums = { gross: number; loads: number; revenueMiles: number; drivenMiles: number; emptyMiles: number };

/** A run of weeks combined the only honest way: add the sums, then divide (never average the weekly ratios). */
export function combineWeeks(ws: WeekSums[]) {
  const gross = sum(ws.map((w) => w.gross));
  const revenueMiles = sum(ws.map((w) => w.revenueMiles));
  const drivenMiles = sum(ws.map((w) => w.drivenMiles));
  return { gross, loads: sum(ws.map((w) => w.loads)), rpm: revenueMiles > 0 ? gross / revenueMiles : null, emptyShare: drivenMiles > 0 ? sum(ws.map((w) => w.emptyMiles)) / drivenMiles : null };
}

export type Growth = { key: "revenue" | "rpm" | "loads" | "empty"; label: string; change: number | null; lowerIsBetter: boolean };

/** The last `span` weeks against the `span` before, for revenue, $/mi, loads and empty miles, all as relative change. */
export function growthOf(weeks: WeekSums[], span = 4): { rows: Growth[]; scale: number } {
  const cur = combineWeeks(weeks.slice(-span));
  const prev = combineWeeks(weeks.slice(-2 * span, -span));
  const rows: Growth[] = [
    { key: "revenue", label: "Revenue", change: changeFraction(cur.gross, prev.gross), lowerIsBetter: false },
    { key: "rpm", label: "Per mile", change: changeFraction(cur.rpm, prev.rpm), lowerIsBetter: false },
    { key: "loads", label: "Loads", change: changeFraction(cur.loads, prev.loads), lowerIsBetter: false },
    { key: "empty", label: "Empty miles", change: changeFraction(cur.emptyShare, prev.emptyShare), lowerIsBetter: true }
  ];
  const biggest = Math.max(0, ...rows.map((r) => Math.abs(r.change ?? 0)));
  // One scale for every column so the bars can be compared: the next round number above the biggest move.
  const scale = [0.1, 0.25, 0.5, 1, 2, 5].find((s) => biggest <= s) ?? biggest;
  return { rows, scale };
}
