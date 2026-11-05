import type { PartnerResult } from "@/truelane/partners/contract";

/**
 * A company's adapter has three layers, so that the day real keys arrive only one of them changes (docs/PARTNER_BACKBONE.md):
 *   1. a CLIENT: the company's own requests and answers, in the company's own shapes. The live client is the only layer that would touch the network, and it does not exist until a company is
 *      chosen and has given us keys and documentation; until then it answers "not implemented". The sandbox client answers the same calls from the simulator, in the same shapes.
 *   2. a NORMALIZER: pure functions that turn the company's shapes into the desk's own (AdapterShapes in ../call.ts). Both clients go through it, so the simulator exercises the code the live
 *      adapter will run.
 *   3. the ADAPTER: glue that asks the client, normalizes, and answers a PartnerResult.
 * Nothing under adapters/ opens a connection. A test fails if it ever does.
 */
export type AdapterCall<I> = { provider: string; input: I; secret: (name: string) => string | undefined };
export type Adapter<I = never, O = unknown> = (call: AdapterCall<I>) => Promise<PartnerResult<O>>;

/** What a live client throws before a company is wired: it is "not implemented", never a failure of the company's. */
export class NotLive extends Error {
  constructor() {
    super("not live");
    this.name = "NotLive";
  }
}

/** The two ways one company's adapter can run: against the company (live) or against the simulator (sandbox). */
export type ProviderAdapter<I, O> = { live: Adapter<I, O>; sandbox: Adapter<I, O> };
