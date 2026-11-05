/* Fixture for the redesign screens. Every name, customer, load and figure is invented (the desk's own sample-data rule).
   Shapes follow the real ones: BoardRow (server/tl/queries), FitRow (server/tl/quote), MoneyState (lib/money-state), Alert (lib/alerts), prisma models.
   The verdict functions below are a straight port of lib/verdict.ts (verdictState, sentenceOf, rulerOf, groundOf, readVerdict). They only say the answer.
   `bandOf` stands in for the audited rules (src/truelane): in the build, band and gate come from the engine, never from this file. */
(function () {
  const usd = (n, d = 0) => (n == null ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
  const mi = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US") + " mi");
  const rpm = (n) => (n == null ? "—" : (n < 0 ? "−" : "") + "$" + Math.abs(n).toFixed(2));
  const rate = (n) => `$${n.toFixed(2)}/mi`;
  const pctS = (f) => `${(Math.abs(f) * 100).toFixed(0)}%`;

  /* ---- lib/verdict.ts, ported ---- */
  const WORD = { take: "Accept", think: "Caution", reject: "Reject", unjudged: "Can't judge yet" };
  const bookingGate = (g) => (g === "no_market" ? null : g);
  function verdictState(f) {
    if (f.band === "below_floor") return "reject";
    if (f.band === "needs_fuel") return "unjudged";
    if (f.band === "strong_caution") return "reject";
    const clean = ["above_market", "at_market", "no_benchmark"].includes(f.band) && bookingGate(f.gate) == null && !f.thinMargin && !f.timeTrap;
    return clean ? "take" : "think";
  }
  const FLOOR_AT = 40, ROOM_RIGHT = 54, ROOM_LEFT = 34, NEAREST = 0.25;
  const on = (a) => Math.round(a * 10) / 10;
  function rulerOf({ floor, offer, market, benchmark = "market" }) {
    const above = Math.max(offer - floor, (market ?? floor) - floor, NEAREST);
    const under = Math.max(floor - offer, floor - (market ?? floor), NEAREST);
    const scale = Math.min(ROOM_RIGHT / above, ROOM_LEFT / under);
    const place = (v) => ({ value: v, at: on(FLOOR_AT + (v - floor) * scale) });
    return { floor: { value: floor, at: FLOOR_AT }, offer: place(offer), market: market == null ? null : place(market), marketName: benchmark === "lane" ? "Your lane" : "Market", scale };
  }
  function sentenceOf(state, f) {
    const margin = f.marginPerMile == null ? null : Math.abs(f.marginPerMile);
    const trip = f.leftOver == null ? null : Math.abs(f.leftOver);
    const clears = margin == null ? "Clears your cost" : `Clears your cost by ${rate(margin)}${trip != null ? `, ${usd(trip)} on this trip` : ""}`;
    const onLane = f.benchmark === "lane", against = onLane ? "your lane average" : "the market";
    if (state === "reject" && f.band !== "below_floor") return `${clears}, but pays ${f.marketPct != null ? pctS(f.marketPct) + " under " + against : "far under " + against}. Too far under to accept.`;
    if (state === "reject") {
      const short = margin == null ? "Short of your cost" : `Short of your cost by ${rate(margin)}${trip != null ? `, ${usd(trip)} on this trip` : ""}`;
      return f.payNeeded != null ? `${short}. It would have to pay ${usd(f.payNeeded)} to cover it.` : `${short}.`;
    }
    if (state === "unjudged") return "The truck has no mpg or fuel price, so its cost is not known yet. Add them on its page.";
    if (state === "take") {
      if (f.band === "above_market") return `${clears}, and pays above ${against}.`;
      if (f.band === "at_market") return onLane ? `${clears}, and pays about what this lane usually pays you.` : `${clears}, and pays about what the market does.`;
      return `${clears}. Market not checked.`;
    }
    if (f.band === "negotiate" && f.marketPct != null) return `${clears}, but pays ${pctS(f.marketPct)} under ${against}. Ask for more.`;
    if (f.thinMargin) return "It clears your cost, but by less than five cents a mile.";
    if (f.timeTrap) return `${clears}, but it is slow money.`;
    return `${clears}.`;
  }
  function readVerdict(f) {
    const state = verdictState(f);
    const drawable = state !== "unjudged" && f.allInPerMile != null;
    const market = f.marketDollars == null || !(f.totalMiles > 0) ? null : (f.gross - f.marketDollars) / f.totalMiles;
    return { state, word: WORD[state], sentence: sentenceOf(state, f), ruler: drawable ? rulerOf({ floor: f.floorPerMile, offer: f.allInPerMile, market, benchmark: f.benchmark }) : null };
  }
  function groundOf(i) {
    return [
      { label: i.miles === "measured" ? "Miles measured on the road" : "Miles as typed", firm: i.miles === "measured" },
      { label: i.fuel === "own" ? "The truck's own fuel price" : i.fuel === "typed" ? "Fuel price typed for this check" : "No fuel price", firm: i.fuel === "own" },
      typeof i.market === "object" ? { label: `Your ${i.market.laneLoads} loads on this lane in the last ${i.market.laneDays} days`, firm: true } : { label: i.market === "typed" ? "Market rate as typed" : "Market not checked", firm: false },
      { label: i.driver ? "This driver's usual pay" : "No driver on this truck", firm: i.driver }
    ];
  }
  /* stand-in for the audited band (src/truelane) */
  function bandOf({ allIn, floor, marketPct, hasFuel = true }) {
    if (!hasFuel) return "needs_fuel";
    if (allIn < floor) return "below_floor";
    if (marketPct == null) return "no_benchmark";
    if (marketPct < -0.2) return "strong_caution";
    if (marketPct < -0.1) return "negotiate";
    if (marketPct < 0.05) return "at_market";
    return "above_market";
  }
  function facts({ gross, miles, floor, marketTotal, benchmark, hasFuel = true }) {
    const allIn = miles > 0 ? gross / miles : null;
    const marketDollars = marketTotal == null ? null : gross - marketTotal;
    const marketPct = marketTotal == null ? null : (gross - marketTotal) / marketTotal;
    const band = bandOf({ allIn, floor, marketPct, hasFuel });
    const margin = allIn == null ? null : allIn - floor;
    const gate = band === "below_floor" || band === "strong_caution" ? "reason" : band === "negotiate" ? "reason" : band === "no_benchmark" ? "no_market" : null;
    return { band, gate, allInPerMile: allIn, floorPerMile: floor, marginPerMile: margin, leftOver: margin == null ? null : margin * miles, totalMiles: miles, gross, marketDollars, marketPct, benchmark, payNeeded: allIn != null && allIn < floor ? floor * miles : null, thinMargin: margin != null && margin >= 0 && margin < 0.05, timeTrap: false };
  }

  /* ---- the fleet (scripts/seed-demo.ts shape) ---- */
  const trucks = [
    { id: "v101", name: "Unit 101", type: "heavy_duty", mpg: 6.8, base: "Dallas, TX", terminal: "Dallas", hos: 6, fuel: 3.9, floor: 1.86, equip: "53 ft · 44,000 lb", profile: true, plate: "TX" },
    { id: "v102", name: "Unit 102", type: "heavy_duty", mpg: 6.5, base: "Houston, TX", terminal: "Houston", hos: 24, fuel: 3.9, floor: 1.91, equip: "53 ft · 44,000 lb", profile: true },
    { id: "v103", name: "Unit 103", type: "box_truck", mpg: 9.2, base: "Oklahoma City, OK", terminal: "Oklahoma City", hos: null, fuel: 3.9, floor: 1.64, equip: "26 ft box · 9,500 lb · liftgate · pallet jack", profile: true }
  ];
  const drivers = [
    { id: "d1", name: "Alex Rivera", truck: "Unit 101", terminal: "Dallas", cdl: "A", cdlExp: "Jun 2027", med: "Apr 2027", pay: "cpm", rate: 0.5, payroll: "ready", phone: "555-0110" },
    { id: "d2", name: "Sam Okafor", truck: "Unit 102", terminal: "Houston", cdl: "A", cdlExp: "Sep 2027", med: "Jun 2027", pay: "cpm", rate: 0.52, payroll: "sent", phone: "555-0111" },
    { id: "d3", name: "Jordan Lee", truck: "Unit 103", terminal: "Oklahoma City", cdl: "A", cdlExp: "Dec 2027", med: "Aug 2027", pay: "hourly", rate: 18, payroll: "none", phone: "555-0112" },
    { id: "d4", name: "Casey Brooks", truck: "Unit 101", terminal: "Dallas", cdl: "A", cdlExp: "Mar 2028", med: "Nov 24, 2026", pay: "cpm", rate: 0.55, payroll: "failed", phone: "555-0113", medSoon: true }
  ];
  const trailers = [
    { no: "T-101", type: "Dry van", hook: "Unit 101", status: "available", terminal: "Dallas", loc: "Dallas yard", reg: "Aug 2027", insp: "May 2027" },
    { no: "T-102", type: "Reefer", hook: "Unit 102", status: "available", terminal: "Houston", loc: "Houston yard", reg: "Jun 2027", insp: "Apr 2027" },
    { no: "T-103", type: "Flatbed", hook: "—", status: "available", terminal: "Dallas", loc: "Dallas yard, door 4", reg: "Dec 2027", insp: "Jul 2027" },
    { no: "T-104", type: "Dry van", hook: "—", status: "in_shop", terminal: "Dallas", loc: "Dallas shop", reg: "Aug 2027", insp: "May 2027" },
    { no: "T-105", type: "Dry van", hook: "—", status: "available", terminal: "Houston", loc: "Houston yard", reg: "Lapsed Oct 25", insp: "Mar 2027", lapsed: true },
    { no: "T-106", type: "Dry van", hook: "—", status: "available", terminal: "Houston", loc: "Houston yard", reg: "May 2027", insp: "Nov 16, 2026", soon: true }
  ];
  const customers = [
    { name: "Sample Freight Co", kind: "broker", mc: "MC 100201", terms: 30, loads: 9, finished: 7, rpm: 2.21, days: 31.4, out: 2480, short: 0, auth: "Active" },
    { name: "Northline Brokerage", kind: "broker", mc: "MC 100344", terms: 30, loads: 8, finished: 6, rpm: 2.34, days: 27.8, out: 1740, short: 1, auth: "Active" },
    { name: "Blue Mesa Logistics", kind: "broker", mc: "MC 100517", terms: 45, loads: 8, finished: 6, rpm: 2.09, days: 44.2, out: 3310, short: 0, auth: "Active" },
    { name: "Harbor and Pine Freight", kind: "broker", mc: "MC 100622", terms: 30, loads: 7, finished: 5, rpm: 2.28, days: 29.1, out: 0, short: 0, auth: "Active" },
    { name: "Redwood Load Partners", kind: "broker", mc: "MC 100789", terms: 30, loads: 6, finished: 4, rpm: 1.97, days: 52.6, out: 4120, short: 1, auth: "Not checked" }
  ];
  const lanes = [
    { from: "Harrisburg, PA", to: "Columbus, OH", n: 3, avg: 2.35, last: "Oct 02", stands: true },
    { from: "Houston, TX", to: "Memphis, TN", n: 4, avg: 2.2, last: "Oct 28", stands: true },
    { from: "Dallas, TX", to: "Atlanta, GA", n: 5, avg: 2.05, last: "Oct 21", stands: true },
    { from: "Chicago, IL", to: "Indianapolis, IN", n: 3, avg: 2.6, last: "Oct 30", stands: true },
    { from: "Dallas, TX", to: "Oklahoma City, OK", n: 2, avg: 2.45, last: "Sep 18", stands: false },
    { from: "Atlanta, GA", to: "Charlotte, NC", n: 3, avg: 2.3, last: "Oct 11", stands: true },
    { from: "Kansas City, MO", to: "St. Louis, MO", n: 1, avg: 2.4, last: "Aug 29", stands: false }
  ];

  /* ---- the open board: one row per load still moving (BoardRow) ---- */
  const T = Object.fromEntries(trucks.map((t) => [t.name, t]));
  const open = [
    ["DM-40041", "Sample Freight Co", "Harrisburg, PA", "Columbus, OH", "Nov 06 08:00", 1, "draft", null, "Unit 101", null, 51, 257.2, 237, 650],
    ["DM-40042", "Northline Brokerage", "Chicago, IL", "Indianapolis, IN", "Nov 05 06:30", 2, "draft", null, "Unit 102", null, 62, 183, 71, 640],
    ["DM-40043", "Blue Mesa Logistics", "Dallas, TX", "Atlanta, GA", "Nov 07 08:00", 3, "draft", "declined", "Unit 101", "Casey Brooks", 48, 781, 0, 1610],
    ["DM-40044", "Harbor and Pine Freight", "Houston, TX", "Memphis, TN", "Nov 05 09:00", 4, "draft", "dispatched", "Unit 102", "Sam Okafor", 15, 560, 190, 1480, { sent: "2 h ago" }],
    ["DM-40045", "Redwood Load Partners", "Atlanta, GA", "Charlotte, NC", "Nov 05 07:00", 5, "draft", "dispatched", "Unit 101", "Alex Rivera", 33, 245, 160, 880, { sent: "5 h ago" }],
    ["DM-40046", "Sample Freight Co", "Nashville, TN", "Louisville, KY", "Nov 05 10:00", 6, "draft", "dispatched", "Unit 103", "Jordan Lee", 27, 175, 80, 520, { sent: "9 h ago" }],
    ["DM-40047", "Northline Brokerage", "Dallas, TX", "Oklahoma City, OK", "Nov 06 07:00", 7, "accepted", "accepted", "Unit 101", "Casey Brooks", 22, 206, 190, 790],
    ["DM-40048", "Blue Mesa Logistics", "Memphis, TN", "Dallas, TX", "Nov 06 13:00", 8, "accepted", "accepted", "Unit 102", "Sam Okafor", 40, 452, 12, 1020],
    ["DM-40049", "Harbor and Pine Freight", "Columbus, OH", "Pittsburgh, PA", "Nov 03 20:00", 9, "in_progress", "in_progress", "Unit 103", "Jordan Lee", 30, 185, 55, 470, { due: "Due Nov 05 12:40", arrived: "Nov 03 19:48" }],
    ["DM-40050", "Redwood Load Partners", "Kansas City, MO", "St. Louis, MO", "Nov 03 09:30", 10, "in_progress", "in_progress", "Unit 101", "Alex Rivera", 38, 248, 150, 860, { late: "Delivery 3 h past window", arrived: "Nov 03 10:21 (late)" }],
    ["DM-40051", "Sample Freight Co", "Chicago, IL", "Indianapolis, IN", "Nov 04 02:00", 11, "in_progress", "in_progress", "Unit 102", "Sam Okafor", 44, 183, 120, 720, { due: "Due Nov 05 08:00", arrived: "Nov 04 01:52" }],
    ["DM-40052", "Northline Brokerage", "Atlanta, GA", "Charlotte, NC", "Nov 04 05:00", 12, "in_progress", "in_progress", "Unit 101", "Casey Brooks", 25, 245, 110, 800, { due: "Due Nov 05 14:00", arrived: "Nov 04 04:50" }],
    ["DM-40053", "Redwood Load Partners", "Kansas City, MO", "St. Louis, MO", "Nov 08 08:00", 13, "draft", null, null, null, 0, 248, 0, 600],
    ["DM-40054", "Blue Mesa Logistics", "Dallas, TX", "Atlanta, GA", "Nov 08 07:00", 14, "draft", null, "Unit 102", null, 88, 781, 260, 1540]
  ].map((a) => {
    const [no, cust, from, to, pu, id, status, asg, truck, driver, dh, loaded, ret, gross, x = {}] = a;
    const miles = dh + loaded + ret;
    const t = truck ? T[truck] : null;
    const ln = lanes.find((l) => l.from === from && l.to === to && l.stands);
    const marketTotal = ln ? ln.avg * loaded : null;
    const f = t ? facts({ gross, miles, floor: t.floor, marketTotal, benchmark: "lane" }) : null;
    const v = f ? readVerdict(f) : { state: "unjudged", word: WORD.unjudged, sentence: "No truck is set, so there is no cost floor and no verdict yet.", ruler: null };
    return { id: "L" + id, marketTotal, no, cust, from, to, pu, status, asg, truck, driver, dh, loaded, ret, miles, gross, perMile: miles ? gross / miles : null, floor: t ? t.floor : null, f, v, ...x, pickupPassed: no === "DM-40041" ? false : false };
  });

  /* ---- history: finished, fell through, and where the money is (MoneyState keys) ---- */
  const history = [
    ["DM-40021", "Sample Freight Co", "Dallas, TX", "Atlanta, GA", "Oct 30", "Unit 101", "Alex Rivera", "completed", 1600, 781, 2.05, 1230, 1.57, 31.2, { key: "not_invoiced", label: "Not invoiced yet", tone: "info" }],
    ["DM-40022", "Northline Brokerage", "Chicago, IL", "Indianapolis, IN", "Oct 29", "Unit 102", "Sam Okafor", "completed", 520, 183, 2.84, 410, 2.24, 38.9, { key: "out", label: "Out and waiting", tone: "warn", detail: "INV-40022 · sent Oct 30" }],
    ["DM-40023", "Redwood Load Partners", "Kansas City, MO", "St. Louis, MO", "Sep 22", "Unit 101", "Casey Brooks", "completed", 600, 248, 2.42, 355, 1.43, 27.0, { key: "overdue", label: "Overdue", tone: "bad", detail: "INV-40023 · 12 days overdue" }],
    ["DM-40024", "Blue Mesa Logistics", "Memphis, TN", "Dallas, TX", "Sep 28", "Unit 102", "Sam Okafor", "completed", 910, 452, 2.01, 640, 1.42, 30.4, { key: "part_overdue", label: "Part paid", tone: "bad", detail: "INV-40024 · $400.00 in, $510.00 to come · 6 days overdue" }],
    ["DM-40025", "Harbor and Pine Freight", "Houston, TX", "Memphis, TN", "Oct 28", "Unit 102", "Sam Okafor", "completed", 1260, 560, 2.25, 905, 1.62, 33.1, { key: "paid", label: "Paid", tone: "ok", detail: "INV-40025 · Nov 02" }],
    ["DM-40026", "Northline Brokerage", "Dallas, TX", "Oklahoma City, OK", "Sep 18", "Unit 101", "Alex Rivera", "completed", 520, 206, 2.52, 380, 1.84, 29.8, { key: "paid_short", label: "Paid short", tone: "bad", detail: "INV-40026 · $40.00 short of $520.00" }],
    ["DM-40027", "Redwood Load Partners", "Atlanta, GA", "Charlotte, NC", "Sep 11", "Unit 101", "Casey Brooks", "completed", 590, 245, 2.41, 330, 1.35, 24.9, { key: "closed_short", label: "Closed short", tone: "bad", detail: "INV-40027 · $75.00 written off: detention not agreed" }],
    ["DM-40028", "Sample Freight Co", "Harrisburg, PA", "Columbus, OH", "Sep 02", "Unit 101", "Alex Rivera", "completed", 604, 257.2, 2.35, 390, 1.52, 22.1, { key: "paid", label: "Paid", tone: "ok", detail: "INV-40028 · Oct 06" }],
    ["DM-40029", "Blue Mesa Logistics", "Nashville, TN", "Louisville, KY", "Aug 27", "Unit 103", "Jordan Lee", "completed", 438, 175, 2.5, 300, 1.71, 26.0, { key: "paid_over", label: "Paid, over", tone: "info", detail: "INV-40029 · $12.00 over $438.00" }],
    ["DM-40030", "Northline Brokerage", "Columbus, OH", "Pittsburgh, PA", "Oct 21", "Unit 103", "Jordan Lee", "tonu", 175, 0, null, null, null, null, { key: "paid", label: "Paid", tone: "ok", detail: "INV-40030 · TONU · Nov 01" }],
    ["DM-40031", "Sample Freight Co", "Dallas, TX", "Atlanta, GA", "Oct 25", "Unit 101", null, "cancelled", 0, 0, null, null, null, null, { reason: "Customer cancelled" }]
  ].map(([no, cust, from, to, done, truck, driver, status, gross, mi, perMile, net, profitMi, rph, money]) => ({ no, cust, from, to, done, truck, driver, status, gross, mi, perMile, net, profitMi, rph, money }));

  const alerts = [
    { level: "block", load: "DM-40042", msg: "Pickup is within 24 hours and no driver has been sent.", rule: "PICKUP_NO_DRIVER" },
    { level: "block", load: "DM-40046", msg: "Jordan Lee is booked on DM-40046 and DM-40049 at the same time.", rule: "DOUBLE_BOOKED" },
    { level: "block", load: "DM-40045", msg: "T-105 registration lapsed Oct 25. Pick another trailer.", rule: "TRAILER_COMPLIANCE" },
    { level: "warn", load: "DM-40050", msg: "On the road and 3 hours past its delivery window.", rule: "LATE_ON_ROAD" },
    { level: "warn", load: "DM-40045", msg: "Sent 5 hours ago, no answer from Alex Rivera yet.", rule: "SENT_NO_ANSWER" },
    { level: "warn", load: "DM-40041", msg: "Pays below Unit 101's cost and no driver has been sent.", rule: "BELOW_COST_UNASSIGNED" },
    { level: "warn", load: "DM-40053", msg: "No truck set, so no cost floor and no verdict.", rule: "NO_TRUCK" },
    { level: "warn", load: "DM-40023", msg: "INV-40023 is 12 days past its Net 30 terms.", rule: "INVOICE_OVERDUE" },
    { level: "warn", load: null, msg: "Casey Brooks's medical card lapses Nov 24 (20 days).", rule: "CLEARANCE_SOON" },
    { level: "info", load: "DM-40021", msg: "Delivered Oct 30 and ready to invoice.", rule: "READY_TO_INVOICE" }
  ];

  window.DESK = {
    usd, mi, rpm, rate, WORD, verdictState, rulerOf, sentenceOf, readVerdict, groundOf, bandOf, facts,
    trucks, drivers, trailers, customers, lanes, open, history, alerts,
    totals: { open: 14, needsDriver: 5, gross: 38420, avgRpm: 2.18, emptyShare: 0.236 },
    counts: { needsDriver: 5, unreadMessages: 3, alerts: 10, alertsBlock: 3, overdue: 2, readyToInvoice: 1 },
    shell: { workspace: "Demo fleet", plan: "pro", account: { name: "Maya Ortiz", role: "dispatcher" }, terminals: ["Dallas", "Houston", "Oklahoma City"] }
  };
})();
