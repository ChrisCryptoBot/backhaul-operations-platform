import React from "react";
import type { Ruler, Verdict, VerdictState } from "@/lib/verdict";

/** "$1.23/mi". */
const rate = (n: number) => `$${n.toFixed(2)}/mi`;

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
  return (
    <span className="vc-tag" data-state={state}>
      <VerdictMark state={state} size={15} />
      {word}
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
  const said = `This load pays ${rate(offer.value)} against a floor of ${rate(floor.value)}${market ? ` and ${marketName.toLowerCase()} at ${rate(market.value)}` : ""}.`;
  return (
    <div className="vc-ruler" data-state={state}>
      <div className="vc-line" role="img" aria-label={said}>
        <span className="vc-rail" />
        <span className="vc-loss" style={{ width: `${floor.at}%` }} />
        <span className="vc-run" style={{ left: `${from}%`, width: `${width}%` }} />
        <span className="vc-floor" style={{ left: `${floor.at}%` }} />
        {market ? <span className="vc-market" style={{ left: `${market.at}%` }} /> : null}
        <span className="vc-offer" style={{ left: `${offer.at}%` }}>
          <VerdictMark state={state} size={20} />
        </span>
      </div>
      <dl className="vc-legend">
        <div>
          <dt><i className="vc-key-floor" />Your floor</dt>
          <dd>{rate(floor.value)}</dd>
        </div>
        <div>
          <dt><i className="vc-key-market" />{marketName}</dt>
          <dd>{market ? rate(market.value) : "Not checked"}</dd>
        </div>
        <div>
          <dt>This load</dt>
          <dd>{rate(offer.value)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The top of the card: the mark and the word, and the sentence that says why. The first thing read, in the same place every time. */
export function VerdictHead({ verdict }: { verdict: Verdict }) {
  return (
    <div className="vc-head">
      <div className="vc-call">
        <VerdictMark state={verdict.state} />
        <span className="vc-word">{verdict.word}</span>
      </div>
      <p className="vc-sentence">{verdict.sentence}</p>
    </div>
  );
}
