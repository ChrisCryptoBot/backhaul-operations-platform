/**
 * The partner showcase (docs/MONEY_PLAN.md, Wave 7 step 5): one load's life through every built-in simulator, in a fleet of its own. Pure: the steps in order and what a screen says about
 * each. The server half is src/server/partners/showcase.ts.
 *
 * Everything runs in SHOWCASE_WORKSPACE_ID, passed explicitly, never the demo fleet's or a real fleet's workspace. Every company here is the desk's own simulator, not the company: the names
 * say which product each simulator is modeled after, and nothing in the showcase is a live connection.
 */
export const SHOWCASE_WORKSPACE_ID = "showcase-workspace";

export const SHOWCASE_STEPS = ["eld", "vetting", "tracking", "fuel", "ifta", "factoring", "payroll", "quickbooks", "webhook", "read_api"] as const;
export type ShowcaseStep = (typeof SHOWCASE_STEPS)[number];
export const isShowcaseStep = (v: unknown): v is ShowcaseStep => typeof v === "string" && (SHOWCASE_STEPS as readonly string[]).includes(v);

export const STEP_INFO: Record<ShowcaseStep, { title: string; modeledOn: string; does: string }> = {
  eld: { title: "Hours and position", modeledOn: "ELD simulator (modeled on Motive)", does: "Reads the truck's position and the driver's three clocks." },
  vetting: { title: "Carrier check", modeledOn: "Vetting simulator (modeled on Highway)", does: "Checks the carrier's authority, safety score and insurance, and gives the desk's verdict." },
  tracking: { title: "Tracking link and delivery", modeledOn: "Tracking simulator (modeled on project44)", does: "Shares a tracking link for this load, takes the signed arrival events, and the load is delivered." },
  fuel: { title: "Fuel card purchases", modeledOn: "Fuel card simulator (modeled on WEX)", does: "Reads the truck's fuel purchases on the trip, with the card's discount." },
  ifta: { title: "Miles by state", modeledOn: "Fuel tax simulator (modeled on ProMiles)", does: "Splits the trip's miles over the states it crossed, for the quarter's IFTA." },
  factoring: { title: "Invoice sold to the factor", modeledOn: "Factoring simulator (modeled on TriumphPay)", does: "Invoices the load, sends it to the factor, and takes the factor's signed funding event: advance, fee and reserve." },
  payroll: { title: "Driver paid", modeledOn: "Payroll simulator (modeled on Gusto)", does: "Finalizes the driver's statement, sends it to payroll, and takes the cleared-run event." },
  quickbooks: { title: "Books synced", modeledOn: "Accounting simulator (modeled on QuickBooks Online)", does: "Signs in (OAuth, simulated) and pushes the invoice and the driver's bill to the books." },
  webhook: { title: "Signed webhooks out", modeledOn: "The desk's own outbound webhooks, to a receiver built into the desk", does: "Sends every money event of the run, signed, to the built-in receiver, which checks each signature." },
  read_api: { title: "Read API", modeledOn: "The desk's own read API", does: "Makes a read key for the showcase fleet and asks GET /api/v1/invoices with it." }
};

export const SIMULATOR_LABEL = "Simulator, not the company";

export type Figure = [label: string, value: string];
export type StepCard = { step: ShowcaseStep; done: boolean; figures: Figure[]; code: string | null; note: string | null };
