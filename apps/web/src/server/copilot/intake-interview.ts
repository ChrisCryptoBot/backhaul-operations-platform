/**
 * Deterministic intake interview for relayed backhaul loads — the copilot's
 * load-birth Q&A.
 *
 * Runs with NO LLM and NO DB so it works even when Anthropic credits are
 * exhausted: the panel round-trips the `IntakeState`, each answer advances one
 * step, and once every field is collected it emits a staged `create_relayed_load`
 * action the user confirms through the normal copilot confirmation path.
 *
 * Base load fields can be pre-seeded from a parsed rate con; any field the seed
 * already supplies is skipped, so the interview asks only what it must — always
 * the relay plan (which a rate con never contains: how many legs, each leg's
 * driver type + driver) plus the deadheads / FSC the carrier sets per load.
 */

export type LegType = "SHUTTLE" | "PTP" | "DELIVERY";

/** Base load fields the interview can pre-fill from a parsed rate con. */
export interface IntakeSeed {
  pickupCity?: string;
  pickupState?: string;
  deliveryCity?: string;
  deliveryState?: string;
  lineHaulRate?: string;
  loadedMiles?: string;
  puDeadheadMiles?: string;
  delDeadheadMiles?: string;
  fscApplies?: boolean;
  brokerName?: string;
  shipperName?: string;
  receiverName?: string;
  /**
   * Rate con this interview was seeded from. Not a question field — it rides in
   * `state.base` across round-trips and links the born load back to its rate con.
   */
  rateConfirmationId?: string;
}

interface LegDraft {
  legType?: LegType;
  /** undefined = unanswered; null = explicitly unassigned. */
  driverName?: string | null;
}

export interface IntakeState {
  step: string;
  legCount?: number;
  legs: LegDraft[];
  base: IntakeSeed;
  /** Questions successfully answered so far (drives the step rail). */
  answered?: number;
}

/** A suggested one-tap answer for the current step (submits the same value). */
export interface IntakeReply {
  label: string;
  value: string;
  mono?: boolean;
  ghost?: boolean;
}

export interface IntakeStaged {
  tool: "create_relayed_load";
  input: Record<string, unknown>;
  summary: string;
}

export interface IntakeResult {
  state: IntakeState;
  /** The next question to show (also re-shown, with `error`, on invalid input). */
  prompt?: string;
  /** Validation message for the answer just given. */
  error?: string;
  /** Set once the interview is complete: the staged load-creation action. */
  done?: IntakeStaged;
  /** 1-based index of the current question (for the step rail). */
  stepNo?: number;
  /** Total questions this interview will ask — undefined until leg count is known. */
  stepTotal?: number;
  /** One-tap suggested answers for the current step (empty for free-text steps). */
  replies?: IntakeReply[];
}

const MAX_LEGS = 4;
const STATE_RE = /^[A-Za-z]{2}$/;
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;

function legIndexOf(step: string): number {
  return Number.parseInt(step.split("_")[1] ?? "0", 10);
}

/** The next unanswered step given the current state, or null when complete. */
function nextStep(s: IntakeState): string | null {
  if (s.legCount === undefined) return "leg_count";
  for (let i = 0; i < s.legCount; i += 1) {
    const leg = s.legs[i] ?? {};
    if (leg.legType === undefined) return `leg_${i}_type`;
    if (leg.driverName === undefined) return `leg_${i}_driver`;
  }
  const b = s.base;
  if (!b.pickupCity || !b.pickupState) return "pickup";
  if (!b.deliveryCity || !b.deliveryState) return "delivery";
  if (!b.lineHaulRate) return "rate";
  if (b.fscApplies === undefined) return "fsc";
  if (!b.puDeadheadMiles) return "pu_dh";
  if (!b.delDeadheadMiles) return "del_dh";
  if (!b.loadedMiles) return "loaded_miles";
  return null;
}

/** One-tap suggested answers for a step; free-text steps return []. */
function repliesFor(step: string): IntakeReply[] {
  if (step === "leg_count") {
    return ["1", "2", "3", "4"].map((v) => ({ label: v, value: v, mono: true }));
  }
  if (step.endsWith("_type")) {
    return (["SHUTTLE", "PTP", "DELIVERY"] as const).map((v) => ({ label: v, value: v, mono: true }));
  }
  if (step.endsWith("_driver")) {
    return [{ label: "Unassigned", value: "unassigned", ghost: true }];
  }
  if (step === "fsc") {
    return [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" }
    ];
  }
  return [];
}

/** Remaining questions (incl. the current one), or null before leg count is known. */
function remainingSteps(s: IntakeState): number | null {
  if (s.legCount === undefined) return null;
  let n = 0;
  for (let i = 0; i < s.legCount; i += 1) {
    const leg = s.legs[i] ?? {};
    if (leg.legType === undefined) n += 1;
    if (leg.driverName === undefined) n += 1;
  }
  const b = s.base;
  if (!b.pickupCity || !b.pickupState) n += 1;
  if (!b.deliveryCity || !b.deliveryState) n += 1;
  if (!b.lineHaulRate) n += 1;
  if (b.fscApplies === undefined) n += 1;
  if (!b.puDeadheadMiles) n += 1;
  if (!b.delDeadheadMiles) n += 1;
  if (!b.loadedMiles) n += 1;
  return n;
}

/** Step rail position for the current state. `stepTotal` is undefined until leg count is set. */
function progress(s: IntakeState): { stepNo: number; stepTotal?: number } {
  const answered = s.answered ?? 0;
  const remaining = remainingSteps(s);
  return { stepNo: answered + 1, stepTotal: remaining === null ? undefined : answered + remaining };
}

function promptFor(step: string, s: IntakeState): string {
  if (step === "leg_count") {
    return "How many relay legs does this load have? (1 = direct pickup→delivery, 2 = pickup→DC then a shuttle, 3 = full relay through a drop lot)";
  }
  if (step.endsWith("_type")) {
    const i = legIndexOf(step);
    return `Leg ${i + 1} of ${s.legCount}: driver type? (SHUTTLE, PTP, or DELIVERY)`;
  }
  if (step.endsWith("_driver")) {
    const i = legIndexOf(step);
    return `Leg ${i + 1}: driver name? (type the name, or "unassigned" if not set yet)`;
  }
  switch (step) {
    case "pickup":
      return 'Pickup city and state? (e.g. "Allentown, PA")';
    case "delivery":
      return 'Delivery city and state? (e.g. "Columbus, OH")';
    case "rate":
      return "Line-haul rate? (dollars, e.g. 1850)";
    case "fsc":
      return "Does fuel surcharge apply? (yes/no)";
    case "pu_dh":
      return "Pickup deadhead miles?";
    case "del_dh":
      return "Delivery deadhead miles?";
    case "loaded_miles":
      return "Loaded miles for this load?";
    default:
      return "…";
  }
}

function parseCityState(raw: string): { city: string; state: string } | null {
  const idx = raw.lastIndexOf(",");
  if (idx <= 0) return null;
  const city = raw.slice(0, idx).trim();
  const state = raw.slice(idx + 1).trim().toUpperCase();
  if (!city || !STATE_RE.test(state)) return null;
  return { city, state };
}

/** Read a trimmed non-empty string off a loosely-typed payload, else undefined. */
function readStr(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/**
 * Map a parsed rate-con `extractedPayload` (see contracts/queue.ts
 * `parserExtractionSchema`) to an interview seed. Splits the combined
 * `originCityState`/`destinationCityState` ("Allentown, PA") into city/state via
 * `parseCityState`. The rate con carries no deadheads / FSC and a combined
 * city-state, so the interview still asks legs, deadheads, and FSC — only the
 * fields the rate con actually contains get pre-filled. Defensive: a partial
 * (regex-fallback) parse simply seeds fewer fields.
 */
export function seedFromExtractedPayload(payload: Record<string, unknown>): IntakeSeed {
  const seed: IntakeSeed = {};
  const origin = readStr(payload, "originCityState");
  if (origin) {
    const parsed = parseCityState(origin);
    if (parsed) {
      seed.pickupCity = parsed.city;
      seed.pickupState = parsed.state;
    }
  }
  const dest = readStr(payload, "destinationCityState");
  if (dest) {
    const parsed = parseCityState(dest);
    if (parsed) {
      seed.deliveryCity = parsed.city;
      seed.deliveryState = parsed.state;
    }
  }
  const rate = readStr(payload, "lineHaulRate");
  if (rate && DECIMAL_RE.test(rate)) seed.lineHaulRate = rate;
  const miles = readStr(payload, "loadedMiles");
  if (miles && DECIMAL_RE.test(miles)) seed.loadedMiles = miles;
  const broker = readStr(payload, "brokerName");
  if (broker) seed.brokerName = broker;
  const shipper = readStr(payload, "shipperName");
  if (shipper) seed.shipperName = shipper;
  const receiver = readStr(payload, "receiverName");
  if (receiver) seed.receiverName = receiver;
  return seed;
}

function buildStaged(s: IntakeState): IntakeStaged {
  const b = s.base;
  const legs = s.legs.map((leg, i) => ({
    legIndex: i,
    legType: leg.legType,
    driverName: leg.driverName ?? null
  }));
  const input: Record<string, unknown> = {
    pickupCity: b.pickupCity,
    pickupState: b.pickupState,
    deliveryCity: b.deliveryCity,
    deliveryState: b.deliveryState,
    lineHaulRate: b.lineHaulRate,
    loadedMiles: b.loadedMiles,
    puDeadheadMiles: b.puDeadheadMiles,
    delDeadheadMiles: b.delDeadheadMiles,
    fscApplies: b.fscApplies ?? false,
    legs
  };
  if (b.brokerName) input.brokerName = b.brokerName;
  if (b.shipperName) input.shipperName = b.shipperName;
  if (b.receiverName) input.receiverName = b.receiverName;
  if (b.rateConfirmationId) input.rateConfirmationId = b.rateConfirmationId;

  const covered = legs.filter((l) => l.driverName).length;
  const chain = legs.map((l) => l.legType).join(" → ");
  const summary =
    `Create relayed load · ${legs.length} leg${legs.length === 1 ? "" : "s"} (${chain}) · ` +
    `${b.pickupCity}, ${b.pickupState} → ${b.deliveryCity}, ${b.deliveryState} · ` +
    `rate $${b.lineHaulRate} · ${covered}/${legs.length} legs covered`;
  return { tool: "create_relayed_load", input, summary };
}

/** Begin a new interview, optionally seeded with parsed rate-con fields. */
export function startIntake(seed: IntakeSeed = {}): IntakeResult {
  const state: IntakeState = { step: "leg_count", legs: [], base: { ...seed }, answered: 0 };
  const step = nextStep(state) ?? "leg_count";
  state.step = step;
  const { stepNo, stepTotal } = progress(state);
  return { state, prompt: promptFor(step, state), stepNo, stepTotal, replies: repliesFor(step) };
}

/** Apply one answer to the current step and return the next prompt, an error, or the staged action. */
export function advanceIntake(prev: IntakeState, answerRaw: string): IntakeResult {
  const state: IntakeState = {
    ...prev,
    legs: (prev.legs ?? []).map((l) => ({ ...l })),
    base: { ...prev.base }
  };
  const answer = (answerRaw ?? "").trim();
  const step = state.step;
  const invalid = (msg: string): IntakeResult => {
    const { stepNo, stepTotal } = progress(state);
    return { state, error: msg, prompt: promptFor(step, state), stepNo, stepTotal, replies: repliesFor(step) };
  };

  if (step === "leg_count") {
    const n = Number.parseInt(answer, 10);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LEGS) return invalid(`Enter a number from 1 to ${MAX_LEGS}.`);
    state.legCount = n;
    state.legs = Array.from({ length: n }, () => ({}) as LegDraft);
  } else if (step.endsWith("_type")) {
    const i = legIndexOf(step);
    const t = answer.toUpperCase();
    if (t !== "SHUTTLE" && t !== "PTP" && t !== "DELIVERY") return invalid("Type SHUTTLE, PTP, or DELIVERY.");
    state.legs[i] = { ...state.legs[i], legType: t as LegType };
  } else if (step.endsWith("_driver")) {
    const i = legIndexOf(step);
    const unassigned = answer === "" || /^(unassigned|none|skip|tbd|n\/a)$/i.test(answer);
    state.legs[i] = { ...state.legs[i], driverName: unassigned ? null : answer };
  } else if (step === "pickup" || step === "delivery") {
    const parsed = parseCityState(answer);
    if (!parsed) return invalid('Use "City, ST" — e.g. "Allentown, PA".');
    if (step === "pickup") {
      state.base.pickupCity = parsed.city;
      state.base.pickupState = parsed.state;
    } else {
      state.base.deliveryCity = parsed.city;
      state.base.deliveryState = parsed.state;
    }
  } else if (step === "rate" || step === "pu_dh" || step === "del_dh" || step === "loaded_miles") {
    if (!DECIMAL_RE.test(answer)) return invalid("Enter a number (up to 4 decimals).");
    if (step === "rate") state.base.lineHaulRate = answer;
    else if (step === "pu_dh") state.base.puDeadheadMiles = answer;
    else if (step === "del_dh") state.base.delDeadheadMiles = answer;
    else state.base.loadedMiles = answer;
  } else if (step === "fsc") {
    const yes = /^(y|yes|true)$/i.test(answer);
    const no = /^(n|no|false)$/i.test(answer);
    if (!yes && !no) return invalid("Answer yes or no.");
    state.base.fscApplies = yes;
  } else {
    return invalid("Unexpected step — restart the intake.");
  }

  state.answered = (state.answered ?? 0) + 1;
  const next = nextStep(state);
  if (next === null) return { state, done: buildStaged(state) };
  state.step = next;
  const { stepNo, stepTotal } = progress(state);
  return { state, prompt: promptFor(next, state), stepNo, stepTotal, replies: repliesFor(next) };
}
