/**
 * The Quote decisions report: what was decided on each quote, by whom, on what, and how well the negotiating went. Pure: the server reads the decisions (`server/tl/quote-report.ts`) and
 * this turns them into the report, so every figure can be checked against a list of decisions.
 *
 * A decision is a booking (accepted, or overridden with a reason) or a pass. Decisions made before the details were kept carry only their type, reason, offer and customer; they count
 * in the totals and are left out of any figure that needs the details (the verdict, the margin, the first offer).
 */
export type DecisionKind = "accepted" | "overridden" | "passed";
export type VerdictKey = "take" | "think" | "reject" | "unjudged";

export type DecisionRow = {
  id: string;
  at: Date;
  kind: DecisionKind;
  by: string;
  reason: string | null;
  notes: string | null;
  customer: string | null;
  lane: string;
  offer: number;
  /** Null for a decision made before the details were kept. */
  verdict: VerdictKey | null;
  benchmark: "market" | "lane" | "none" | null;
  marginPerMile: number | null;
  leftOver: number | null;
  marketVariancePct: number | null;
  firstOffer: number | null;
  truck: string | null;
  fuelPrice: number | null;
  fuelSource: "typed" | "regional" | null;
};

export type Count = { booked: number; passed: number; overridden: number };
export type PersonRow = Count & { name: string; decisions: number; overrideRate: number | null; avgMargin: number | null };
export type CustomerRow = Count & { name: string; avgMargin: number | null };
export type Measure = { key: string; label: string; value: number | null; target: number; of: number; text: string; score: number | null };

export type QuoteReport = {
  total: number;
  booked: number;
  passed: number;
  overridden: number;
  acceptanceRate: number | null;
  byVerdict: Record<VerdictKey, Count>;
  withoutDetails: number;
  overrides: { reasons: Array<{ reason: string; count: number; leftOver: number }>; moneyLeftOnOverrides: number; belowFloor: number };
  negotiation: { raised: number; ofWithFirst: number; avgRaise: number | null; avgRaisePct: number | null; passedOnRate: number; passedUnderMarketPct: number | null };
  people: PersonRow[];
  customers: CustomerRow[];
  weeks: Array<{ start: Date; booked: number; passed: number; overridden: number }>;
  measures: Measure[];
  grade: { letter: "A" | "B" | "C" | "D" | "F"; score: number } | null;
  fuel: { regional: number; typed: number; truckOwn: number };
};

const MIN_FOR_GRADE = 5;
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
const emptyCount = (): Count => ({ booked: 0, passed: 0, overridden: 0 });
const bump = (c: Count, kind: DecisionKind) => {
  if (kind === "passed") c.passed += 1;
  else {
    c.booked += 1;
    if (kind === "overridden") c.overridden += 1;
  }
};

/** The Sunday (UTC) a moment falls in the week of, as a time. */
const weekOf = (t: Date): Date => {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
};

export const letterFor = (score: number): "A" | "B" | "C" | "D" | "F" => (score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F");

export function buildQuoteReport(rows: readonly DecisionRow[], weeksShown = 12): QuoteReport {
  const booked = rows.filter((r) => r.kind !== "passed");
  const passed = rows.filter((r) => r.kind === "passed");
  const overridden = rows.filter((r) => r.kind === "overridden");

  const byVerdict: Record<VerdictKey, Count> = { take: emptyCount(), think: emptyCount(), reject: emptyCount(), unjudged: emptyCount() };
  for (const r of rows) if (r.verdict) bump(byVerdict[r.verdict], r.kind);

  const reasons = new Map<string, { count: number; leftOver: number }>();
  for (const r of overridden) {
    const k = r.reason ?? "No reason kept";
    const cur = reasons.get(k) ?? { count: 0, leftOver: 0 };
    cur.count += 1;
    cur.leftOver += r.leftOver ?? 0;
    reasons.set(k, cur);
  }
  const moneyLeftOnOverrides = overridden.reduce((s, r) => s + (r.leftOver != null && r.leftOver < 0 ? r.leftOver : 0), 0);
  const belowFloor = booked.filter((r) => r.marginPerMile != null && r.marginPerMile < 0).length;

  const withFirst = booked.filter((r) => r.firstOffer != null && r.firstOffer > 0);
  const raisedRows = withFirst.filter((r) => r.offer > r.firstOffer!);
  const rateLost = passed.filter((r) => r.reason === "Rate too low");
  const underMarket = rateLost.map((r) => r.marketVariancePct).filter((v): v is number => v != null);

  const byPerson = new Map<string, DecisionRow[]>();
  const byCustomer = new Map<string, DecisionRow[]>();
  for (const r of rows) {
    byPerson.set(r.by, [...(byPerson.get(r.by) ?? []), r]);
    const c = r.customer?.trim() || "No customer typed";
    byCustomer.set(c, [...(byCustomer.get(c) ?? []), r]);
  }
  const margins = (xs: DecisionRow[]) => mean(xs.filter((x) => x.kind !== "passed" && x.marginPerMile != null).map((x) => x.marginPerMile!));
  const people: PersonRow[] = [...byPerson.entries()]
    .map(([name, xs]) => {
      const c = emptyCount();
      for (const x of xs) bump(c, x.kind);
      return { name, ...c, decisions: xs.length, overrideRate: c.booked > 0 ? c.overridden / c.booked : null, avgMargin: margins(xs) };
    })
    .sort((a, b) => b.decisions - a.decisions);
  const customers: CustomerRow[] = [...byCustomer.entries()]
    .map(([name, xs]) => {
      const c = emptyCount();
      for (const x of xs) bump(c, x.kind);
      return { name, ...c, avgMargin: margins(xs) };
    })
    .sort((a, b) => b.booked + b.passed - (a.booked + a.passed))
    .slice(0, 10);

  const weekMap = new Map<number, { start: Date; booked: number; passed: number; overridden: number }>();
  for (const r of rows) {
    const start = weekOf(r.at);
    const w = weekMap.get(start.getTime()) ?? { start, booked: 0, passed: 0, overridden: 0 };
    if (r.kind === "passed") w.passed += 1;
    else {
      w.booked += 1;
      if (r.kind === "overridden") w.overridden += 1;
    }
    weekMap.set(start.getTime(), w);
  }
  const weeks = [...weekMap.values()].sort((a, b) => a.start.getTime() - b.start.getTime()).slice(-weeksShown);

  // The grade: three plain measures, each against a target, averaged. It says nothing until there are enough decisions to say it about.
  const known = booked.filter((r) => r.marginPerMile != null);
  const measures: Measure[] = [
    {
      key: "discipline",
      label: "Booked without an override",
      value: booked.length > 0 ? 1 - overridden.length / booked.length : null,
      target: 0.9,
      of: booked.length,
      text: "A reason was needed to book fewer than one load in ten.",
      score: null
    },
    {
      key: "floor",
      label: "Booked loads that cleared their cost",
      value: known.length > 0 ? known.filter((r) => r.marginPerMile! >= 0).length / known.length : null,
      target: 0.95,
      of: known.length,
      text: "Nearly every load booked paid more than it cost to run.",
      score: null
    },
    {
      key: "raise",
      label: "Quotes raised before they were booked",
      value: withFirst.length > 0 ? raisedRows.length / withFirst.length : null,
      target: 0.25,
      of: withFirst.length,
      text: "At least one booked quote in four was pushed above the first offer.",
      score: null
    }
  ];
  for (const m of measures) m.score = m.value == null ? null : Math.min(100, (m.value / m.target) * 100);
  const scored = measures.filter((m) => m.score != null);
  const score = rows.length >= MIN_FOR_GRADE && scored.length > 0 ? mean(scored.map((m) => m.score!))! : null;

  return {
    total: rows.length,
    booked: booked.length,
    passed: passed.length,
    overridden: overridden.length,
    acceptanceRate: rows.length > 0 ? booked.length / rows.length : null,
    byVerdict,
    withoutDetails: rows.filter((r) => r.verdict == null).length,
    overrides: { reasons: [...reasons.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count), moneyLeftOnOverrides, belowFloor },
    negotiation: {
      raised: raisedRows.length,
      ofWithFirst: withFirst.length,
      avgRaise: mean(raisedRows.map((r) => r.offer - r.firstOffer!)),
      avgRaisePct: mean(raisedRows.map((r) => (r.offer - r.firstOffer!) / r.firstOffer!)),
      passedOnRate: rateLost.length,
      passedUnderMarketPct: mean(underMarket)
    },
    people,
    customers,
    weeks,
    measures,
    grade: score == null ? null : { letter: letterFor(score), score },
    fuel: {
      regional: booked.filter((r) => r.fuelSource === "regional").length,
      typed: booked.filter((r) => r.fuelSource === "typed").length,
      truckOwn: booked.filter((r) => r.verdict != null && r.fuelSource == null).length
    }
  };
}
