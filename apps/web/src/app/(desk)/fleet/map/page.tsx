import { scopeWords } from "@/lib/scope";
import React from "react";
import { CanGate } from "@/components/desk/kit/can-gate";
import { SyncEldButton } from "@/components/desk/partner-actions";
import { RadarView } from "@/components/desk/radar-map";
import { readRadarParams } from "@/lib/radar-points";
import { PageHead } from "@/components/desk/ui";
import { partnerState } from "@/server/partners/call";
import { requirePage } from "@/server/tl/access";
import { getRadarData } from "@/server/tl/radar";
import { radarPoints } from "@/server/tl/radar-query";
import { currentTerminal } from "@/server/tl/terminal";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Radar map · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * The radar: where every tractor and trailer is, from the ELD, on a map the desk draws itself, with what idling and a dropped trailer are costing. Positions are as of the last ELD read (the
 * rail says how old); a dispatcher can read the ELD now. A person with no ELD connected is told how to connect one.
 */
export default async function RadarPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  await requirePage("read");
  const terminal = await currentTerminal();
  const params = readRadarParams((k) => searchParams?.[k]);
  const [data, eld] = await Promise.all([getRadarData(currentWorkspaceId(), terminal), partnerState("eld")]);
  const initial = await radarPoints(data, params);
  return (
    <>
      <PageHead title="Radar map" sub={`${scopeWords(terminal) ? `${scopeWords(terminal)}. ` : ""}Where every tractor and trailer is, and what idling and dropped trailers are costing. Positions are as of the last ELD read.`} />
      <RadarView
        initial={initial}
        params={params}
        actions={
          <CanGate caps={["dispatch"]}>
            <SyncEldButton reason={eld.reason} />
          </CanGate>
        }
      />
    </>
  );
}
