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
| `take` | Take it | Circle (go) | Green | Clears the cost, at or above the market, and nothing the rules pause on |
| `think` | Think twice | Diamond (warning) | Amber | Clears the cost, but under the market, thin, slow money, or no market rate to compare |
| `below` | Below your cost | Octagon (stop) | Red | Under the floor |
| `unjudged` | Can't judge yet | Empty dashed ring | None | The cost is not known (no mpg or fuel price) |

Four, and no fifth. `unjudged` is not a point on the scale from good to bad, so it has no colour and no ruler: the card does not draw what it does not know.

**Your cost owns the verdict.** The market can move a good load to Think twice. It can never make a load green on its own, and it can never rescue a load below cost.

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
4. **The buttons.** Below cost, "Pass on it" is the main button and booking becomes "Book anyway". A load that needs a reason says "Book with a reason" before it is pressed.
5. **Hue.** Last, and it only repeats the others.

**The test for any change:** set the page to grayscale. If you can no longer tell the four states apart, the change is wrong.

## Rules for the skin

- Glass and Barlow are the current skin, and they stay. A skin may change without touching the verdict.
- One light, behind the top of the card, where the mark is. It repeats the verdict; it never carries it alone.
- The word is set in the ordinary text colour. It does not need hue to be read.
- Hue is not used on the figure.
- No coloured strip down an edge (the desk's standing rule). Tone is the mark.

## What it rests on

The card says what it took on trust: miles as typed, a market rate someone typed, no fuel price, no driver. A confident answer built on a guess is the one way this card can lose people's trust, so it says so on its face. As the desk learns to measure more, this line gets shorter.

## Not done yet

- **The Loads board, Dispatch and the load page** still use the older verdict words (`VerdictChip`). They should move to the same four states, which needs the market band alongside the decision.
- **The phone** still has its own card. Porting `verdict.ts` and the mark is what makes this one card across the product.
- Booked loads do not yet show what the verdict said against what actually happened. That record is the card's long game.
