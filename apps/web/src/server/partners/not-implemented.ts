import { err, type PartnerResult } from "@/truelane/partners/contract";

/** A company that is not wired yet: a result, not an error, that a screen shows as "not connected yet". Its own file so adapters can use it without importing the call path. */
export const notImplemented = (provider: string): PartnerResult<never> => err("not_implemented", `${provider} is not connected to TrueLane yet.`);
