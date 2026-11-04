"use client";

import React from "react";
import { createPortal } from "react-dom";
import { CARD_LINES, type Ruler, type Verdict, type VerdictState } from "@/lib/verdict";

/** "$1.23/mi". */
const rate = (n: number) => `$${n.toFixed(2)}/mi`;

/**
 * Hover (or Tab to) any part of the card and it says what it is and how it is worked out, so the card teaches its own logic. One tooltip per card, drawn on the page itself so a
 * card edge never clips it. `on(title, body)` returns what to spread on a part; `tip` goes once anywhere in the card.
 */
function useExplain() {
  const [shown, setShown] = React.useState<{ title: string; body: string; cx: number; top: number; bottom: number } | null>(null);
  const on = (title: string, body: string) => {
    const show = (e: React.SyntheticEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setShown({ title, body, cx: r.left + r.width / 2, top: r.top, bottom: r.bottom });
    };
    return { tabIndex: 0, "data-learn": "", onMouseEnter: show, onFocus: show, onMouseLeave: () => setShown(null), onBlur: () => setShown(null) };
  };
  const tip =
    shown && typeof document !== "undefined"
      ? createPortal(
          <ExplainTip {...shown} />,
          document.body
        )
      : null;
  return { on, tip };
}

/**
 * The tooltip itself. It is measured once drawn and then kept wholly inside the window: centred on the part when there is room, slid left or right when there is not, and put above the
 * part when there is no room below, so it can always be read however far over the part sits.
 */
function ExplainTip({ title, body, cx, top, bottom }: { title: string; body: string; cx: number; top: number; bottom: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [at, setAt] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const gap = 8;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(gap, Math.min(cx - w / 2, window.innerWidth - w - gap));
    const below = bottom + 10;
    const y = below + h + gap <= window.innerHeight ? below : Math.max(gap, top - 10 - h);
    setAt({ left, top: y });
  }, [title, body, cx, top, bottom]);
  return (
    <div ref={ref} className="vc-explain" role="tooltip" style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? "visible" : "hidden" }}>
      <b>{title}</b>
      <span>{body}</span>
    </div>
  );
}

/** What each of the four verdicts means, in the words of the rules that decide it. */
const STATE_EXPLAIN: Record<VerdictState, { title: string; body: string }> = {
  take: {
    title: "Accept: the check",
    body: "It pays more than it costs to run this truck, and it is not well under the market. Your cost decides this; the market can only make a good load worth a second look."
  },
  think: {
    title: "Caution: the diamond",
    body: `It clears your cost, but something deserves a second look: a margin under ${CARD_LINES.thinCentsPerMile} cents a mile, pay more than ${CARD_LINES.atMarketPct}% under the market, or a lot of hours for little money.`
  },
  reject: {
    title: "Reject: the stop sign",
    body: `It pays less than it costs to run, or more than ${CARD_LINES.rejectPct}% under the market. Accepting it loses money or leaves a lot on the table.`
  },
  unjudged: {
    title: "Can't judge yet: the empty ring",
    body: "There is nothing honest to measure yet. Type the offer and the loaded miles, and give the truck a cost profile and a fuel price: without them the floor is not the whole cost."
  }
};

/**
 * The verdict's mark. The shapes are the road's, which every driver already reads at speed and in any light: a round go, a diamond warning, an octagon stop, and an empty ring for
 * nothing to judge. They read in black and white; the colour only repeats them. Decorative to a screen reader: the word always sits beside it.
 */
export function VerdictMark({ state, size = 34 }: { state: VerdictState; size?: number }) {
  return (
    <svg className="vc-mark" data-state={state} width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      {state === "take" ? (
        <>
          <circle className="vc-fill" cx="18" cy="18" r="16" />
          <path className="vc-sign" d="M10.5 18.5l5 5 10-11" />
        </>
      ) : state === "think" ? (
        <>
          <path className="vc-fill" d="M18 1.5L34.5 18 18 34.5 1.5 18z" />
          <path className="vc-sign" d="M18 10v10M18 25.6v.4" />
        </>
      ) : state === "reject" ? (
        <>
          <path className="vc-fill" d="M11.2 2h13.6L34 11.2v13.6L24.8 34H11.2L2 24.8V11.2z" />
          <path className="vc-sign" d="M12 12l12 12M24 12L12 24" />
        </>
      ) : (
        <circle className="vc-ring" cx="18" cy="18" r="15" />
      )}
    </svg>
  );
}

/** A verdict's mark and word on one line, for a table row or a bar. The same two things as the card, smaller. */
export function VerdictTag({ state, word }: { state: VerdictState; word: string }) {
  const { on, tip } = useExplain();
  const what = STATE_EXPLAIN[state];
  return (
    <span className="vc-tag" data-state={state} {...on(what.title, what.body)}>
      <VerdictMark state={state} size={15} />
      {word}
      {tip}
    </span>
  );
}

/**
 * Where the load lands against what it costs. The floor stands in the same place on every card, so this reads by position alone, from across a room, in black and white: right of
 * the floor pays, the hatched side loses.
 */
export function VerdictRuler({ ruler, state }: { ruler: Ruler; state: VerdictState }) {
  const { floor, offer, market, marketName } = ruler;
  const from = Math.min(floor.at, offer.at);
  const width = Math.abs(offer.at - floor.at);
  const { on, tip } = useExplain();
  const said = `This load pays ${rate(offer.value)} against a floor of ${rate(floor.value)}${market ? ` and ${marketName.toLowerCase()} at ${rate(market.value)}` : ""}.`;
  const gap = offer.value - floor.value;
  const FLOOR = `What a mile costs to run this truck, from its cost profile: fuel, fixed bills, upkeep and the driver. It stands in the same place on every card, so right of it you make money and left of it you lose it. Now ${rate(floor.value)}.`;
  const MARKET = market
    ? `${marketName} pays ${rate(market.value)} on this lane. ${marketName === "Market" ? "It is the rate you typed." : "With no market rate typed, it is your own recent loads on the lane."} It can make a good load worth a second look, and a load more than ${CARD_LINES.rejectPct}% under it is a Reject, but it never turns a verdict green.`
    : "No market rate was typed and the lane has too few recent loads of yours to stand in for one, so this load is judged on its cost alone.";
  const THIS = `What this load pays per mile in all, with the fuel surcharge, over every mile driven, empty ones included. Now ${rate(offer.value)}. The mark on it is the verdict.`;
  return (
    <div className="vc-ruler" data-state={state}>
      <div className="vc-line" role="img" aria-label={said}>
        <span className="vc-rail" />
        <span className="vc-loss" style={{ width: `${floor.at}%` }} {...on("The hatched side loses money", "Anything left of the floor pays less than a mile costs. The further left, the more each mile loses.")} />
        <span
          className="vc-run"
          style={{ left: `${from}%`, width: `${width}%` }}
          {...on(gap >= 0 ? "Your margin" : "Your shortfall", `The gap between what this load pays and your floor, on every mile: ${rate(Math.abs(gap))}. ${gap >= 0 ? "It is what is left after the truck is paid for." : "Each mile loses this much."}`)}
        />
        <span className="vc-floor" style={{ left: `${floor.at}%` }} {...on("Your floor", FLOOR)} />
        {market ? <span className="vc-market" style={{ left: `${market.at}%` }} {...on(marketName, MARKET)} /> : null}
        <span className="vc-offer" style={{ left: `${offer.at}%` }} {...on("This load", THIS)}>
          <VerdictMark state={state} size={20} />
        </span>
      </div>
      <dl className="vc-legend">
        <div {...on("Your floor", FLOOR)}>
          <dt><i className="vc-key-floor" />Your floor</dt>
          <dd>{rate(floor.value)}</dd>
        </div>
        <div {...on(market ? marketName : "Not checked", MARKET)}>
          <dt><i className="vc-key-market" />{marketName}</dt>
          <dd>{market ? rate(market.value) : "Not checked"}</dd>
        </div>
        <div {...on("This load", THIS)}>
          <dt>This load</dt>
          <dd>{rate(offer.value)}</dd>
        </div>
      </dl>
      {tip}
    </div>
  );
}

/** The top of the card: the mark and the word, and the sentence that says why. The first thing read, in the same place every time. */
export function VerdictHead({ verdict }: { verdict: Verdict }) {
  const { on, tip } = useExplain();
  const what = STATE_EXPLAIN[verdict.state];
  return (
    <div className="vc-head">
      <div className="vc-call" {...on(what.title, what.body)}>
        <VerdictMark state={verdict.state} />
        <span className="vc-word">{verdict.word}</span>
      </div>
      <p className="vc-sentence" {...on("Why, in one sentence", "Worked out from this truck's cost profile and the load's own miles and pay: the same sums the phone does, so the two always agree.")}>
        {verdict.sentence}
      </p>
      {tip}
    </div>
  );
}
