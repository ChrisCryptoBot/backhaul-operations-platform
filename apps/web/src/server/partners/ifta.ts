import { currentWorkspaceId } from "@/server/tl/workspace";
import { routeIftaMiles, type IftaRouteResult } from "./ifta-mileage";

/**
 * IFTA (money plan Wave 5): a quarter's miles by state live in `ifta_mileage` (server/partners/ifta-mileage.ts): the ELD's own pieces where the ELD reported a truck (step 5a), routed legs from
 * the truck's loads where it did not (step 5b). "Work out this quarter" is the routed fallback. It no longer writes `ifta_lines` or works gallons out from miles per gallon: fuel used is the
 * return's (step 6), from all fuel bought. `ifta_lines` stays in the database, unread, until step 9 drops it.
 */
export { IFTA_MAX_LOADS, quarterBounds } from "./ifta-mileage";

export type IftaResult = IftaRouteResult;

export async function calculateIfta(quarter: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<IftaResult> {
  return routeIftaMiles(quarter, now, workspaceId);
}
