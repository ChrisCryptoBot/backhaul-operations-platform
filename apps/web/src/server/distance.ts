/**
 * Provider-agnostic road-mileage lookup. Today it implements Google Distance
 * Matrix; the interface is intentionally narrow so PC*Miler (or another routing
 * provider) can be swapped in behind the same `getRoadMiles` call.
 *
 * Best-effort: if no API key is configured (or the call fails), it returns
 * `{ miles: null, source: "unavailable" }` so callers can fall back to asking
 * the user for the mileage instead of erroring.
 */
import { Prisma } from "@prisma/client";

const METERS_PER_MILE = 1609.344;

export interface RoadMilesResult {
  miles: number | null;
  source: "google" | "unavailable";
}

export interface RoadMilesInput {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
}

export async function getRoadMiles(input: RoadMilesInput): Promise<RoadMilesResult> {
  const provider = process.env.DISTANCE_PROVIDER ?? "google";
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (provider !== "google" || !apiKey) {
    return { miles: null, source: "unavailable" };
  }

  const origin = `${input.originCity}, ${input.originState}`;
  const destination = `${input.destCity}, ${input.destState}`;

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
    url.searchParams.set("origins", origin);
    url.searchParams.set("destinations", destination);
    url.searchParams.set("units", "imperial");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return { miles: null, source: "unavailable" };
    }
    const data = (await response.json()) as {
      status?: string;
      rows?: Array<{ elements?: Array<{ status?: string; distance?: { value?: number } }> }>;
    };
    const element = data.rows?.[0]?.elements?.[0];
    if (
      data.status !== "OK" ||
      !element ||
      element.status !== "OK" ||
      typeof element.distance?.value !== "number"
    ) {
      return { miles: null, source: "unavailable" };
    }
    const miles = new Prisma.Decimal(element.distance.value).div(METERS_PER_MILE).toDecimalPlaces(1).toNumber();
    return { miles, source: "google" };
  } catch {
    return { miles: null, source: "unavailable" };
  }
}
