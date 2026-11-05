# How to reconcile

Short answer: **keep every mechanic, and make the screen say what the mechanics say.** The desk reads as machine-made because its look is the generic "dark glass app" kit, while the thing that makes it yours (a floor per truck, provenance on every figure, four verdicts) is drawn the same size and colour as everything else. The Bloomberg look is not black and amber. It is a few rules that happen to fit this product exactly.

## What makes it read as generic (specific)

1. **The skin is the default premium-dark kit.** `globals.css` has radii up to 20px (`--db-r-card`) plus `999px` pills; `desk.css` has 17 `backdrop-filter`s, 14 gradients, about 53 `box-shadow`s; `DeskShell` floats the sidebar and header 12px in from the edge, with a sliding "bubble" capsule that overshoots, and a fixed ambient glow (`--db-glow-*`). Barlow Condensed in caps is the current "industrial" font. None of it answers a question a dispatcher has. It is also what every generated app looks like, which is the "Pixar" you describe.
2. **Gold means everything, so it means nothing.** `--db-accent` / `--db-accent-fg` is the kicker over every section, the hero figure, the primary button and the focus ring (`DESIGN_BRIEF.md` rule 2). Semantic colour is then competing with decoration (the glow behind the verdict, the gold).
3. **One fact, three names.** The audit fixed the numbers; the labels drifted around it.
   - `quote-desk.tsx` `CounterOfferAssistant`: buttons say "Target (+10%)" and "Target (+15%)", the code adds **$0.25 and $0.50 a mile** over break-even (its own tooltips say so).
   - The truck inspector says "COST FLOOR", "TRIP NET", "ALL-IN $/MI"; `GLOSSARY.md` says **Floor**, **Left Over**, **All-In**. The load page adds "Per Mile, Every Mile", "Margin after fuel", "Left after all trip costs", "Net pay".
   - The Loads board, Dispatch and `load-view.tsx` (`VERDICT_WORDS`) still say "Covers your cost / Barely covers your cost / Below your cost" while the card says Accept / Caution / Reject (`VERDICT_CARD.md`, "Not done yet").
4. **Off-token drift where nobody was looking.** `quote-desk.tsx` carries raw `fontSize: 11`, `fontFamily: "monospace"`, inline `<kbd>` borders and per-button inline borders; two segmented controls (`.tl-seg`, `.cp-seg`); three kinds of card (`.tl-card`, `.qt-eval-card`, `.qt-matrix-wrap`). Headers in marketing voice ("High-Speed Industrial Quoting Terminal", "Dispatch Cockpit", a pulsing `cp-telemetry-ping` dot) are decoration with a telemetry costume.
5. **The card hides its working.** `verdict-card.tsx` `useExplain` teaches by hover tooltip. On the face there is a slab with a light behind it. You cannot check the sum at a glance, which is the one thing a money screen is for.

## What reconciling means here

The mechanics are two things: **one comparison** (All-In against Floor, over every mile) and **provenance** (measured, on record, typed by a person, or not known: `groundOf`, "typed wins", "what it rests on"). A terminal look earns its authority by making exactly those two things unmissable. So:

- **Ink has jobs.** Gold is what a thing *is* (labels, headers, the current row). White is a figure measured or on record. **Blue is a figure a person typed.** Green, amber and red appear only on a verdict, a delta or a money state, never on a figure, label or button. The gold you own gets a job instead of a decoration; the blue is rule 7 ("typed wins") made visible.
- **Everything has a place.** Panels tile on 1px rules, each with a code (`QT`, `LD`, `DQ`) and a header bar; columns are right-aligned tabular figures; rows are 24px. The rail is a list of mnemonics.
- **The book is always on screen.** A ticker (open loads, need a driver, gross, All-In, empty miles) and a status line replace the glass header and the footer note.
- **The verdict card becomes a ticket.** Same four shapes, same words, same ruler with the floor fixed at 40%. Now the working is a ladder you can audit (Pay, every mile, All-In, Floor, Margin, Left over), with "what it rests on" under it. Hover or tab to any line and a fixed strip says what it is.
- **No ornament.** Radius 0, no blur, no shadow, no glow, no pill. The only pattern is the hatch left of the floor, because it means "loses money".
- **Take the discipline, not the paint.** No clone of the Bloomberg screen, its colours' exact values or its chrome. No chat box either (removed on purpose).

## What does not change

The audited math, the six canonical names, the four verdict states and what triggers them, the "reason is asked for" rule, Customer-not-broker, the accessibility baseline, `useDraft`, both themes. Day stays, as the same system on a light ground and for printing; dropping it would save one token block and cost bright rooms.

Everything else is in `INTEGRATION.md`; proposals that change behaviour are listed there on their own.
