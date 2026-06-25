import { NextResponse } from "next/server";

// FSC parked (spot-broker-first): the fuel-surcharge index write endpoint is disabled while FSC
// is neutralized. The FuelSurchargeIndex table, server/fsc.ts, and FSC_INDEX permissions are kept
// dormant for a future direct-3PL re-add — restore the upsert handler then.
export async function POST() {
  return NextResponse.json(
    { error: "Fuel surcharge entry is disabled. FSC is not tracked in the current spot-broker model." },
    { status: 410 }
  );
}
