import React from "react";
import { CanGate } from "@/components/desk/kit/can-gate";
import { SyncEldButton } from "@/components/desk/partner-actions";
import { RadarView } from "@/components/desk/radar-map";
import { PageHead } from "@/components/desk/ui";
import { partnerState } from "@/server/partners/call";
import { requirePage } from "@/server/tl/access";
import { getRadarData } from "@/server/tl/radar";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Radar map · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * The radar: where every tractor and trailer is, from the ELD, on a map the desk draws itself, with what idling and a dropped trailer are costing. Positions are as of the last ELD read (the
 * rail says how old); a dispatcher can read the ELD now. A person with no ELD connected is told how to connect one.
 */
export default async function RadarPage() {
  await requirePage("read");
  const terminal = await currentTerminal();
  const [data, eld] = await Promise.all([getRadarData(currentWorkspaceId(), terminal), partnerState("eld")]);
  return (
    <>
      <PageHead title="Radar map" sub={`${terminal ? `${terminal} terminal. ` : ""}Where every tractor and trailer is, and what idling and dropped trailers are costing. Positions are as of the last ELD read.`} />
      <RadarView
        initial={data}
        actions={
          <CanGate caps={["dispatch"]}>
            <SyncEldButton reason={eld.reason} />
          </CanGate>
        }
      />
    </>
  );
}
