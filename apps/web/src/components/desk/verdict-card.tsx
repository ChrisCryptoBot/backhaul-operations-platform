"use client";

import React from "react";
import { CARD_LINES, type Ground, type Ruler, type Verdict, type VerdictState } from "@/lib/verdict";

/** "$1.23/mi". */
const rate = (n: number) => `$${n.toFixed(2)}/mi`;

type Say = { title: string; body: string };
const Explain = React.createContext<((s: Say) => void) | null>(null);

/**
 * The card teaches its own logic. Hover (or Tab to) any part and one fixed strip at the foot of the card says what it is and how it is worked out; the strip keeps the last thing said,
 * so it can be read without holding the pointer still. Inside a card (`ExplainScope`) `on(title, body)` returns what to spread on a part; outside one (a table row) it is a plain title.
 */
export function ExplainScope({ children }: { children: React.ReactNode }) {
  const [said, setSaid] = React.useState<Say | null>(null);
  return (
    <Explain.Provider value={setSaid}>
      {children}
      <div className="vc-explain" role="status" aria-live="polite">
        <b>{said?.title ?? "Hover or tab to any figure."}</b> {said?.body ?? "It says what it is and how it is worked out."}
      </div>
    </Explain.Provider>
  );
}

function useExplain() {
  const set = React.useContext(Explain);
  return (title: string, body: string) => (set ? { tabIndex: 0, "data-learn": "", onMouseEnter: () => set({ title, body }), onFocus: () => set({ title, body }) } : { title: `${title}. ${body}` });
}

/** What each of the four verdicts means, in the words of the rules that decide it. */
const STATE_EXPLAIN: Record<VerdictState, Say> = {
  take: {
    title: "Accept: the check.",
    body: "It pays more than it costs to run this truck, and it is not well under the market. Your cost decides this; the market can only make a good load worth a second look."
  },
  think: {
    title: "Caution: the diamond.",
    body: `It clears your cost, but something deserves a second look: a margin under ${CARD_LINES.thinCentsPerMile} cents a mile, pay more than ${CARD_LINES.atMarketPct}% under the market, or a lot of hours for little money.`
  },
  reject: {
    title: "Reject: the stop sign.",
    body: `It pays less than it costs to run, or more than ${CARD_LINES.rejectPct}% under the market. Accepting it loses money or leaves a lot on the table.`
  },
  unjudged: {
    title: "Can't judge yet: the empty ring.",
    body: "There is nothing honest to measure yet. Type the offer and the loaded miles, and give the truck a cost profile and a fuel price: without them the floor is not the whole cost."
  }
};

const GLYPH: Record<VerdictState, string> = { take: "✓", think: "!", reject: "✕", unjudged: "" };

/**
 * The verdict's mark. The shapes are the road's, which every driver already reads at speed and in any light: a round go, a diamond warning, an octagon stop, and an empty ring for
 * nothing to judge. They read in black and white (the shape and the glyph carry it; the fill only repeats it). Decorative to a screen reader: the word always sits beside it.
 */
export function VerdictMark({ state, size = 34 }: { state: VerdictState; size?: number }) {
  return (
    <span className="vm" data-s={state} aria-hidden="true" style={{ "--s": `${size}px` } as React.CSSProperties}>
      <span>{GLYPH[state]}</span>
    </span>
  );
}

/** A verdict's mark and word on one line, for a table row or a bar. The same two things as the card, smaller. */
export function VerdictTag({ state, word }: { state: VerdictState; word: string }) {
  const on = useExplain();
  const what = STATE_EXPLAIN[state];
  return (
    <span className="vc-tag" data-state={state} {...on(what.title, what.body)}>
      <VerdictMark state={state} size={15} />
      {word}
    </span>
  );
}

/**
 * Where the load lands against what it costs. The floor stands in the same place on every card (40%), so this reads by position alone, in black and white: right of the floor pays,
 * the hatched side loses. The ticks are 25 cents a mile apart; the scale is worked out from the ruler's own two marks, so the rules file is untouched.
 */
export function VerdictRuler({ ruler, state }: { ruler: Ruler; state: VerdictState }) {
  const { floor, offer, market, marketName } = ruler;
  const on = useExplain();
  const said = `This load pays ${rate(offer.value)} against a floor of ${rate(floor.value)}${market ? ` and ${marketName.toLowerCase()} at ${rate(market.value)}` : ""}.`;
  const gap = offer.value - floor.value;
  const clamp = (at: number) => Math.max(1, Math.min(99, at));
  const FLOOR = `What a mile costs to run this truck, from its cost profile: fuel, fixed bills, upkeep and the driver. It stands in the same place on every card, so right of it you make money and left of it you lose it. Now ${rate(floor.value)}.`;
  const MARKET = market
    ? `${marketName} pays ${rate(market.value)} on this lane. ${marketName === "Market" ? "It is the rate you typed." : "With no market rate typed, it is your own recent loads on the lane."} It can make a good load worth a second look, and a load more than ${CARD_LINES.rejectPct}% under it is a Reject, but it never turns a verdict green.`
    : "No market rate was typed and the lane has too few recent loads of yours to stand in for one, so this load is judged on its cost alone.";
  const THIS = `What this load pays per mile in all, with the fuel surcharge, over every mile driven, empty ones included. Now ${rate(offer.value)}. The mark on it is the verdict.`;
  // Percent of the line per dollar a mile, from the two marks that are placed; a tick every 25 cents.
  const apart = market && Math.abs(market.value - floor.value) > Math.abs(offer.value - floor.value) ? market : offer;
  const scale = Math.abs(apart.value - floor.value) > 0.001 ? (apart.at - floor.at) / (apart.value - floor.value) : null;
  const ticks: number[] = [];
  if (scale != null) for (let k = -6; k <= 6; k++) if (k !== 0) {
    const at = floor.at + k * 0.25 * scale;
    if (at > 1 && at < 99) ticks.push(at);
  }
  const tone = state === "take" ? "var(--pos-fill)" : state === "think" ? "var(--warn-fill)" : "var(--neg-fill)";
  const from = Math.min(floor.at, clamp(offer.at));
  const width = Math.abs(clamp(offer.at) - floor.at);
  const lane = marketName === "Your lane";
  return (
    <div className="vc-ruler" data-state={state}>
      <div className="vc-rule" role="img" aria-label={said}>
        <div className="trk" />
        <div className="loss" style={{ width: `${floor.at}%` }} {...on("The hatched side loses money.", "Anything left of the floor pays less than a mile costs. The further left, the more each mile loses.")} />
        {ticks.map((t) => (
          <div key={t} className="tk" style={{ left: `${t.toFixed(1)}%` }} />
        ))}
        <div className="run" style={{ left: `${from}%`, width: `${width}%`, background: tone }} {...on(gap >= 0 ? "Your margin." : "Your shortfall.", `The gap between what this load pays and your floor, on every mile: ${rate(Math.abs(gap))}. ${gap >= 0 ? "It is what is left after the truck is paid for." : "Each mile loses this much."}`)} />
        <div className="flr" style={{ left: `${floor.at}%` }} {...on("Your floor.", FLOOR)} />
        <div className="tg" style={{ left: `${floor.at}%` }}>FLOOR</div>
        {market ? (
          <>
            <div className="mkt" style={{ left: `${clamp(market.at)}%` }} {...on(marketName + ".", MARKET)} />
            <div className="tg" style={{ left: `${clamp(market.at)}%` }}>{lane ? "LANE" : "MARKET"}</div>
          </>
        ) : null}
        <div className="off" style={{ left: `${clamp(offer.at)}%` }} {...on("This load.", THIS)}>
          <VerdictMark state={state} size={20} />
        </div>
      </div>
      <div className="vc-legend">
        <span>▨ loses money</span>
        <span>
          floor {rate(floor.value)} · {market ? `${marketName.toLowerCase()} ${rate(market.value)}` : "market not checked"} · this load {rate(offer.value)}
        </span>
        <span>pays ▸</span>
      </div>
    </div>
  );
}

/** The top of the card: the mark and the word, the sentence that says why, and (optionally) the one figure on the right. The first thing read, in the same place every time. */
export function VerdictHead({ verdict, figure }: { verdict: Verdict; figure?: React.ReactNode }) {
  const on = useExplain();
  const what = STATE_EXPLAIN[verdict.state];
  return (
    <div className="vc-head">
      <div className="vc-call">
        <span className="vc-call-id">
          <VerdictMark state={verdict.state} size={36} />
          <span className="vc-word" {...on(what.title, what.body)}>{verdict.word}</span>
        </span>
        {figure ? <div className="vc-figure">{figure}</div> : null}
      </div>
      <p className="vc-sent" {...on("Why, in one sentence.", "Worked out from this truck's cost profile and the load's own miles and pay: the same sums the phone does, so the two always agree.")}>
        {verdict.sentence}
      </p>
    </div>
  );
}

export type LadderLine = { k: string; v: string; say: Say; tone?: "typed" | "neg" | "pos"; sum?: boolean };

/** The working, as a ladder a person can audit at a glance: each line is one step of the sum, and Left over is the total at the foot. */
export function VerdictLadder({ lines }: { lines: LadderLine[] }) {
  const on = useExplain();
  return (
    <dl className="t-kv" aria-label="The working">
      {lines.map((l) => (
        <React.Fragment key={l.k}>
          <dt {...on(l.say.title, l.say.body)}>{l.k}</dt>
          <dd className={[l.tone ? `t-${l.tone}` : "", l.sum ? "sum" : ""].filter(Boolean).join(" ") || undefined}>{l.v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** What the verdict stands on. A solid square is measured or on the desk's own record; an open one is taken on trust. The shape says it, so it reads without colour. */
export function VerdictRests({ ground }: { ground: Ground[] }) {
  return (
    <div className="vc-rest" aria-label="What this rests on">
      {ground.map((g) => (
        <span key={g.label} className={g.firm ? "firm" : "trust"}>
          <i aria-hidden="true">{g.firm ? "■" : "□"}</i>
          {g.label}
          <span className="db-sr-only">{g.firm ? " (measured or on record)" : " (taken on trust)"}</span>
        </span>
      ))}
    </div>
  );
}
