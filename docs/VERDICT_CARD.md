# The verdict card

The one thing in TrueLane that does not change. The product goes from an owner-operator's phone to a white-label company's desk; the inputs, the screens and the style will all change, and the card will not. Read this before touching it.

## Three layers

| Layer | What it is | Lives in | How often it changes |
|---|---|---|---|
| **The rules** | The audited math: the floor, the bands, the gate | `src/truelane` (vendored from the phone) | Only with an audit |
| **The verdict** | The answer as data: state, word, sentence, ruler, what it rests on | `src/lib/verdict.ts` | Rarely. This is what has to last |
| **The skin** | Glass, type, the light behind it | `desk.css`, `components/desk/verdict-card.tsx` | Whenever fashion moves |

The verdict does no costing and changes no rule. It only says the answer. A card, a table row, a phone, a watch, a voice and an agent's audit log are all ways of drawing the same object. New surfaces draw the object; they do not work out their own answer.

## The four states

| State | Word | Shape | Light | When |
|---|---|---|---|---|
| `take` | Take it | Circle (go) | Green | Clears the cost, at or above the market (or the lane), or with nothing to compare, and nothing the rules pause on |
| `think` | Think twice | Diamond (warning) | Amber | Clears the cost, but under the market (or the lane), thin, or slow money |
| `reject` | Reject | Octagon (stop) | Red | Under the floor, or paying more than 20% under the market (or the lane) |
| `unjudged` | Can't judge yet | Empty dashed ring | None | The cost is not known (no mpg or fuel price) |

Four, and no fifth. `unjudged` is not a point on the scale from good to bad, so it has no colour and no ruler: the card does not draw what it does not know.

**Your cost owns the verdict.** The market can move a good load to Think twice, and a load paying more than 20% under it to Reject. That line is the audited strong-caution band, not a new threshold; the rules already ask for a reason there. The market can never make a load green on its own, and it can never rescue a load below cost.

**Reject advises, it does not forbid.** A reason still books a Reject ("Book anyway"), and the reason is kept with the decision. A hard stop that only a manager can lift is a separate question and is not built. With no fuel price the cost is not known, so that stays Can't judge yet, whatever the market says. Thin margin and slow money stay Think twice: they are a second look, not a stop. The lane's average can reject, as a typed market rate does; it rests on at least 3 loads, so it is the thinnest ground a Reject stands on.

**No market rate is not a mark against a load** (Chris, 2026-10-31). Most small fleets have no market rate to hand, and a card that says Think twice on every load teaches people to stop reading it. So with the box blank:

1. **The lane stands in, when there is enough of it.** By default at least 3 finished loads on the same city pair in the last 90 days (both are thresholds in Settings: 2 to 25 loads, 14 to 365 days), of the same trailer type when the quote states one. Their average per loaded mile, times this load's loaded miles, takes the market rate's place, so the audited rules decide what it means: same thresholds, same words, same reason asked at over 20% under. The card names it "Your lane", never the market. It is the desk's own record, so it is not "taken on trust".
2. **Otherwise cost alone.** It says "Market not checked" and books with no reason.

A lane figure is for judging only. It is never saved on the load: a saved `marketBenchmark` always means somebody typed a market rate. The audit event for the booking records it as "Read against". All this is the desk's reading (`bookingGate` in `lib/verdict.ts`, `laneBenchmark` in `server/tl/quote.ts`). The audited rule on the phone still asks for a reason; it changes only through the math audit.

## The skeleton, top to bottom

1. **Who it was priced for** (the truck and the driver).
2. **The mark and the word.** The first thing read, in the same place every time.
3. **The sentence.** Why, with the money in it.
4. **The figure.** All-in, over every mile driven, with the miles it is over.
5. **The ruler.** Floor, market, this load, on one line.
6. **The working.** Pay, against the market, fuel, driver pay, anything to pause on.
7. **What it rests on.** What was taken on trust.
8. **The actions.**

The order does not change between surfaces. A smaller surface drops from the bottom, never the top: the bar on a narrow desk and a row in the fit table are the mark and the word and nothing else required.

## The five carriers

A verdict is said five ways at once, so it survives losing any of them:

1. **The word.**
2. **The shape.** The road's own: a driver already reads these at speed, in any light. They need a light edge, because a mid-tone fill sinks into dark glass with the colour off.
3. **Position on the ruler.** The floor stands at the same place on every card, so a load is read by where it lands: right of the floor pays, the hatched side loses. The scale does not zoom in, so two cents over looks like two cents.
4. **The buttons.** On a Reject, "Reject it" is the main button and booking becomes "Book anyway". A load that needs a reason says "Book with a reason" before it is pressed.
5. **Hue.** Last, and it only repeats the others.

**The test for any change:** set the page to grayscale. If you can no longer tell the four states apart, the change is wrong.

## Rules for the skin

- Glass and Barlow are the current skin, and they stay. A skin may change without touching the verdict.
- One light, behind the top of the card, where the mark is. It repeats the verdict; it never carries it alone.
- The word is set in the ordinary text colour. It does not need hue to be read.
- Hue is not used on the figure.
- No coloured strip down an edge (the desk's standing rule). Tone is the mark.

## Thresholds

Settings > Thresholds has a "The verdict card" group with the two lines the desk owns: how many finished loads a lane needs to stand in for a market rate, and how far back they count. They are stored per workspace (`lane_min_loads`, `lane_days`; blank means the default) and read in `laneBenchmark`.

Beside them the same screen shows the lines the audited rules draw (10% under is still at market, more than 20% under is Reject, under 5 cents a mile over cost is thin). Those are shown, not set: the phone uses the same ones, and they change only through the math audit. `CARD_LINES` in `lib/verdict.ts` holds the figures for the screen, and `tests/thresholds.test.ts` pins them to the vendored rules, so an audit that moves a line fails a test instead of leaving the screen wrong.

## What it rests on

The card says what it took on trust: miles as typed, a market rate someone typed, no fuel price, no driver. A confident answer built on a guess is the one way this card can lose people's trust, so it says so on its face. As the desk learns to measure more, this line gets shorter.

## Not done yet

- **The Loads board, Dispatch and the load page** still use the older verdict words (`VerdictChip`). They should move to the same four states, which needs the market band alongside the decision.
- **The phone** still has its own card, and still asks for a reason with no market rate. Porting `verdict.ts` and the mark, and taking that rule through the math audit, is what makes this one card across the product.
- Booked loads do not yet show what the verdict said against what actually happened. That record is the card's long game.
