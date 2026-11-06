import Link from "next/link";
import React from "react";
import { EFFECT_NOTE, EFFECT_ORDER, EFFECT_LABEL, type Bridge, type MoveRow, type WeekTotals } from "@/lib/moves";
import { usd } from "@/lib/desk-format";
import type { Moves } from "@/server/tl/moves";
import { Card } from "../ui";

/**
 * "Why it moved" in pieces. Every dollar is a figure from lib/moves.ts: the result of each week, the change, and the effects that add back to it. Nothing is rounded for the screen except to cents, and the
 * list of effects under a row always adds to the change shown on that row.
 */
const money = (n: number) => usd(n, 2);
const signed = (n: number) => (n > 0 ? `+${money(n)}` : money(n));
const tone = (n: number) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const miles = (n: number) => `${Math.round(n).toLocaleString("en-US")} mi`;

export function MovesHero({ m }: { m: Moves }) {
  const b = m.desk.bridge;
  return (
    <section aria-label="What moved">
      <div className="km-hero">
        <div className="km-label">Result, the week ending {m.after.label} against the week ending {m.before.label}</div>
        <div className="km-herorow">
          <span className={`km-big mv-${tone(b.change)}`}>{signed(b.change)}</span>
          <span className="km-sub">
            {money(b.before)} the week before, {money(b.after)} this week
          </span>
        </div>
        <div className="km-sub">
          {m.desk.before.loads} {m.desk.before.loads === 1 ? "load" : "loads"} the week before, {m.desk.after.loads} this week · gross and billed detention, less the fuel, tolls and other costs recorded on the loads
        </div>
      </div>
      <div className="km km-3">
        <div className="km-cell">
          <div className="km-label">Loaded miles</div>
          <div className="km-value">{miles(m.desk.after.loadedMiles)}</div>
          <div className="km-foot">
            <span className="km-sub">{miles(m.desk.before.loadedMiles)} the week before</span>
          </div>
        </div>
        <div className="km-cell">
          <div className="km-label">Empty miles</div>
          <div className="km-value">{miles(m.desk.after.emptyMiles)}</div>
          <div className="km-foot">
            <span className="km-sub">{miles(m.desk.before.emptyMiles)} the week before</span>
          </div>
        </div>
        <div className="km-cell">
          <div className="km-label">Line haul per loaded mile</div>
          <div className="km-value">{rate(m.desk.after)}</div>
          <div className="km-foot">
            <span className="km-sub">{rate(m.desk.before)} the week before</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const rate = (t: WeekTotals) => (t.loadedMiles > 0 ? `$${(t.lineHaul / t.loadedMiles).toFixed(2)}` : "—");

/** The effects of one bridge, one per line, with what each one means. */
export function EffectList({ bridge, notes = true }: { bridge: Bridge; notes?: boolean }) {
  if (bridge.effects.length === 0) return <p className="tl-note">Nothing changed.</p>;
  return (
    <div className="mv-effects" role="list">
      {bridge.effects.map((e) => (
        <div className="mv-effect" role="listitem" key={e.key}>
          <span className="mv-name">{e.label}</span>
          <span className={`mv-amt mv-${tone(e.dollars)}`}>{signed(e.dollars)}</span>
          {notes ? <span className="mv-note">{EFFECT_NOTE[e.key]}</span> : null}
        </div>
      ))}
      <div className="mv-effect mv-total" role="listitem">
        <span className="mv-name">Change in result</span>
        <span className={`mv-amt mv-${tone(bridge.change)}`}>{signed(bridge.change)}</span>
      </div>
    </div>
  );
}

export function DeskBridge({ m }: { m: Moves }) {
  return (
    <Card title="What moved it, the whole desk">
      <EffectList bridge={m.desk.bridge} />
      {m.desk.bridge.method === "whole" ? <p className="tl-note">One of the two weeks has no loaded miles, so the rate and the miles cannot be told apart for the whole desk.</p> : null}
    </Card>
  );
}

/** Each lane or customer: what it made in each week, the change, and (opened) what moved it. Biggest change first. */
export function MoveList({ m, hrefFor }: { m: Moves; hrefFor: (by: "lane" | "customer") => string }) {
  const what = m.by === "lane" ? "lane" : "customer";
  return (
    <Card title={m.by === "lane" ? "By lane" : "By customer"} action={<Link href={hrefFor(m.by === "lane" ? "customer" : "lane")} className="tl-btn sm">By {m.by === "lane" ? "customer" : "lane"}</Link>}>
      {m.rows.length === 0 ? (
        <p className="tl-note">No finished loads in either week.</p>
      ) : (
        <div className="mv-list">
          <div className="mv-head" aria-hidden="true">
            <span>{what === "lane" ? "Lane" : "Customer"}</span>
            <span className="num">Week before</span>
            <span className="num">This week</span>
            <span className="num">Change</span>
          </div>
          {m.rows.map((r) => (
            <Row key={r.key} r={r} />
          ))}
          {m.more.count > 0 ? (
            <div className="mv-row mv-more">
              <span>
                {m.more.count} more {m.more.count === 1 ? what : `${what}s`}, each with a smaller change
              </span>
              <span />
              <span />
              <span className={`num mv-${tone(m.more.change)}`}>{signed(m.more.change)}</span>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Row({ r }: { r: MoveRow }) {
  const b = r.bridge;
  const top = [...b.effects].sort((x, y) => Math.abs(y.dollars) - Math.abs(x.dollars)).slice(0, 2);
  return (
    <details className="mv-detail">
      <summary className="mv-row">
        <span className="mv-label">
          {r.label}
          <span className="mv-top">
            {b.method === "whole" ? (r.before.loads === 0 ? "Ran only this week" : "Ran only the week before") : top.map((e) => `${EFFECT_LABEL[e.key]} ${signed(e.dollars)}`).join(" · ")}
          </span>
        </span>
        <span className="num">{money(b.before)}</span>
        <span className="num">{money(b.after)}</span>
        <span className={`num mv-${tone(b.change)}`}>{signed(b.change)}</span>
      </summary>
      <div className="mv-open">
        <EffectList bridge={b} notes={false} />
        <p className="tl-note">
          {r.before.loads} {r.before.loads === 1 ? "load" : "loads"} before, {r.after.loads} this week · {miles(r.before.loadedMiles)} loaded and {miles(r.before.emptyMiles)} empty before, {miles(r.after.loadedMiles)} and {miles(r.after.emptyMiles)} this week
        </p>
      </div>
    </details>
  );
}

export function MovesHow({ m }: { m: Moves }) {
  const slim = m.noCosts.before + m.noCosts.after;
  const loads = m.desk.before.loads + m.desk.after.loads;
  return (
    <>
      {slim > 0 ? (
        <p className="tl-note warn" role="note" style={{ maxWidth: 820 }}>
          {slim} of the {loads} loads in these two weeks have no fuel, tolls or other cost recorded. The cost lines (empty miles, and fuel and other costs per mile) read lower than they are when costs are missing; the rate, the surcharge and the detention lines do not depend on them.
        </p>
      ) : null}
      <details className="kc-how">
        <summary>How this is worked out</summary>
        <p className="tl-note" style={{ marginTop: 8, maxWidth: 820 }}>
          The weeks are the dashboard&apos;s own: seven days ending now (or that many days back), and the one before. The result of a week is its gross (line haul, fuel surcharge, TONU and layover pay) and the detention billed on invoices,
          less the fuel, tolls and other costs recorded on the loads. It is not profit: the truck&apos;s fixed costs are not in it. The effects below add back to the change exactly, to the cent.
        </p>
        <div className="mv-effects" style={{ maxWidth: 820 }}>
          {EFFECT_ORDER.map((k) => (
            <div className="mv-effect" key={k}>
              <span className="mv-name">{EFFECT_LABEL[k]}</span>
              <span />
              <span className="mv-note">{EFFECT_NOTE[k]}</span>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}
