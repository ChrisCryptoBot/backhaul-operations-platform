import { prisma } from "@/lib/db";
import type { FuelProduct, FuelStatus } from "@/lib/fuel-normalize";
import { PROVIDERS, SECRET_ENV, err, isCapability, providerConfigured, resolveProvider, type Capability, type PartnerResult } from "@/truelane/partners/contract";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceReader } from "./credentials";
import type { QboAnswer, QboRequest } from "./adapters/quickbooks";
import { recordHealth } from "./health";
import { routed } from "./adapters";
import type { Adapter } from "./adapters/types";
import { notImplemented } from "./not-implemented";

export type { Adapter };
export { notImplemented };

/**
 * The one path every call to a partner company takes from the desk, the same order as the Edge Functions' (supabase/functions/_shared/partners/run.ts): the provider is
 * chosen, its secrets are checked (server environment, read at the time of the call, never sent to the browser), the workspace's connection is checked, and only then the
 * provider's adapter is called. No company is chosen yet, so every adapter is the stub below and answers `not_implemented`: a result, not an error, that a screen shows as
 * "not connected yet". The adapters live in a registry so the day a company is chosen its call replaces one entry, and a test can stand one in.
 */
/** `secret(name)` is one of the company's keys by name, the fleet's own first and then the server's, read for this call only: an adapter never has to know where it came from. */
const stub: Adapter<never, never> = async ({ provider }) => notImplemented(provider);

/** A load's lane for the simulator: where the tractor picks up and delivers, when, and whether the load is on the road (then it is somewhere along the lane whatever the clock says). */
export type SimTrip = { origin: { lat: number; lng: number }; destination: { lat: number; lng: number }; startsAt: number; endsAt: number; inProgress: boolean };

/** One fuel purchase in the desk's words, as a card adapter (or the CSV importer) hands it to the store. */
export type PurchaseOut = {
  on: string;
  gallons: number | null;
  amount: number;
  id?: string;
  location?: string | null;
  pricePerGallon?: number | null;
  discountPerGallon?: number | null;
  discount?: number | null;
  state?: string | null;
  city?: string | null;
  product?: FuelProduct;
  taxPaid?: boolean;
  purchasedAt?: string | null;
  status?: FuelStatus;
};

/** What each capability's adapter reads and answers: the desk's own shapes, not any company's. */
export type AdapterShapes = {
  factoring: { in: { loadId: string; loadNumber: string | null; invoiceNumber: string | null; amount: number; packet: string[] }; out: { referenceId: string; status: string } };
  eld: {
    in: {
      vehicles: Array<{
        id: string;
        name: string | null;
        eldVehicleId: string | null;
        /** What the simulator needs to put a tractor on its lane: the open load's places and times, and where the tractor lives. A live adapter ignores both. */
        trip?: SimTrip | null;
        home?: { lat: number; lng: number } | null;
      }>;
      drivers?: Array<{ id: string; name: string; eldDriverId: string | null; vehicleId: string | null }>;
      /** Also list everything the company has (its whole fleet and roster), for the one-click import. */
      discover?: boolean;
      /** The moment this read is for (epoch ms). A live adapter reads the company at the moment it is called; the simulator answers for this one, so a read at the same moment answers the same. */
      asOf?: number;
    };
    out: {
      vehicles: Array<{
        id: string;
        eldVehicleId: string | null;
        hosAvailableHours: number | null;
        /** Where the tractor was last seen. */
        location?: { lat: number; lng: number; at: string } | null;
        /** What the ELD said about the engine at that fix. */
        speedMph?: number | null;
        headingDeg?: number | null;
        engine?: "moving" | "idle" | "off" | null;
        /** Hours the engine has idled today, and how long it has been standing with the engine on (minutes). */
        idleHoursToday?: number | null;
        idleMinutes?: number | null;
        vin?: string | null;
      }>;
      /** The minutes left on each of a driver's clocks. */
      drivers?: Array<{ id: string; eldDriverId: string | null; driveMinutes: number; shiftMinutes: number; cycleMinutes: number }>;
      /** With `discover`: the company's whole fleet and roster, as the desk would add them. */
      roster?: {
        vehicles: Array<{ eldVehicleId: string; number: string; vin: string | null; make: string | null; model: string | null; year: number | null }>;
        drivers: Array<{ eldDriverId: string; name: string; licenseNumber: string | null; /** The company's vehicle this driver is assigned to. */ eldVehicleId?: string | null; driveMinutes: number; shiftMinutes: number; cycleMinutes: number }>;
      };
    };
  };
  fuel_card: {
    /** `asOf` is the desk's clock (epoch ms): the simulator answers for it, so a purchase on the last day reads pending and later settled. A live adapter ignores it. */
    in: { vehicleName: string | null; accountId: string; since: string | null; until: string | null; asOf?: number };
    /**
     * `amount` is what the card was charged, after the discount. `state` and `city` are where it was bought (state as a two-letter code), `product` and `status` the desk's words from
     * lib/fuel-normalize.ts, `purchasedAt` the moment (ISO) when the company gives one.
     */
    out: { purchases: Array<PurchaseOut> };
  };
  tracking: {
    in: { loadId: string; share: boolean; loadNumber?: string | null; stops?: Array<{ sequence: number; role: string; city: string; lat?: number | null; lng?: number | null; /** When the stop's window opens. */ opensAt?: string | null }> };
    out: { sharing: boolean; /** The link a customer follows. */ shareUrl?: string | null; milestones?: Array<{ stop: number; kind: "arrived" | "departed"; at: string }> };
  };
  vetting: {
    in: { mcNumber: string | null; dotNumber: string | null };
    out: { status: "clear" | "review" | "failed"; coiExpiresAt: string | null; safetyScore?: number | null; authorityActive?: boolean; liabilityCoverage?: number | null; cargoCoverage?: number | null; flags?: string[] };
  };
  /**
   * Payroll: send a batch of statements (one run), or ask where a run stands (Wave 4 step 5: the status poll). A status answer is `pending` until the run clears; `paid` (with the day it
   * cleared) or `rejected` / `mixed` name each statement's outcome, with the company's reason for a refusal.
   */
  payroll: {
    in:
      | { op?: "send"; statements: Array<{ id: string; number: string; employeeId: string | null; workerType: string | null; total: number; periodStart: string; periodEnd: string; idempotencyKey?: string }> }
      | { op: "status"; reference: string; /** When the desk sent the run, and the desk's clock now (ISO): the simulator clears a run a set time after it was sent. */ sentAt: string; asOf: string; statements: Array<{ id: string; employeeId: string | null }> };
    out: { reference: string; state?: "pending" | "paid" | "rejected" | "mixed"; paidAt?: string | null; payments?: Array<{ id: string; status: string; reason?: string | null }> };
  };
  ifta: {
    in: { quarter: string; vehicles: Array<{ id: string; name: string | null }>; /** The quarter's delivered loads, each with its places and miles. */ trips?: Array<{ id: string; vehicleId: string; origin: string; destination: string; miles: number; mpg?: number | null }> };
    out: { jurisdictions: Array<{ state: string; miles: number; gallons: number }> };
  };
  /**
   * Accounting (QuickBooks Online first; docs/MONEY_PLAN.md, Wave 3): one request to the accounting system, with the sign-in it goes under (adapters/quickbooks.ts has the shapes). `tenant`
   * keeps one fleet's simulated books apart from another's; a live call ignores it. `at` is the desk's clock, so the simulator's change feed can be tested.
   */
  accounting: {
    in: { auth: { accessToken: string; realmId: string; tenant: string }; at: string; request: QboRequest };
    out: QboAnswer;
  };
};

export const partnerAdapters: { [K in Capability]: Adapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]> } = {
  factoring: routed("factoring"),
  eld: routed("eld"),
  fuel_card: routed("fuel_card"),
  tracking: routed("tracking"),
  vetting: routed("vetting"),
  payroll: routed("payroll"),
  ifta: routed("ifta"),
  accounting: routed("accounting")
};

const env = (name: string) => process.env[name];

export type PartnerState = { provider: string; configured: boolean; connected: boolean; /** Why a call would not go through now, in words, or null. */ reason: string | null };

const NAME: Record<string, string> = { triumphpay: "TriumphPay", motive: "Motive", samsara: "Samsara", atob: "AtoB", wex: "WEX", project44: "project44", fourkites: "FourKites", highway: "Highway", gusto: "Gusto", promiles: "ProMiles", quickbooks: "QuickBooks Online", csv: "CSV file" };
export const providerName = (p: string) => NAME[p] ?? p;

/** Where a capability stands for this workspace: the provider a call would use, whether its keys are set, and whether the workspace connected it. Booleans and words only. */
export async function partnerState(capability: Capability, requested?: string | null, workspaceId = currentWorkspaceId()): Promise<PartnerState> {
  const provider = resolveProvider(capability, requested ?? undefined) ?? PROVIDERS[capability][0]!;
  const reader = await workspaceReader(provider, workspaceId);
  const configured = providerConfigured(provider, reader);
  const connected = configured && (await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } })) > 0;
  const reason = !configured ? `${providerName(provider)} has no keys yet: set this fleet's keys in Settings, or ask whoever runs the server.` : !connected ? `${providerName(provider)} is not connected for this fleet. Connect it in Settings.` : null;
  return { provider, configured, connected, reason };
}

/** Make a call: provider, keys, connection, then the adapter. Returns the provider used with the result, so a caller can say which company answered. */
export async function callPartner<K extends Capability>(capability: K, requested: string | null | undefined, input: AdapterShapes[K]["in"], workspaceId = currentWorkspaceId()): Promise<{ provider: string; result: PartnerResult<AdapterShapes[K]["out"]> }> {
  if (!isCapability(capability)) return { provider: "", result: err("bad_request", "Unknown capability.") };
  const provider = resolveProvider(capability, requested ?? undefined);
  if (!provider) return { provider: "", result: err("bad_request", "That company is not one TrueLane works with for this.", "provider") };
  const reader = await workspaceReader(provider, workspaceId);
  if (!providerConfigured(provider, reader)) return { provider, result: err("not_configured", `${providerName(provider)} has no keys yet: set this fleet's keys in Settings, or ask whoever runs the server.`) };
  const connected = await prisma.partnerConnection.count({ where: { workspaceId, capability, provider, status: "connected" } });
  if (connected === 0) return { provider, result: err("not_connected", `${providerName(provider)} is not connected for this fleet.`) };
  let result: PartnerResult<AdapterShapes[K]["out"]>;
  try {
    result = await (partnerAdapters[capability] as Adapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]>)({ provider, input, secret: reader });
  } catch {
    // Whatever the company's call threw is not shown or kept: a reading that failed is "upstream_error".
    result = err("upstream_error", `${providerName(provider)} did not answer.`);
  }
  // The connection keeps how its last call went (never a body or a message the company wrote): a run of failures is shown, and a success clears it.
  await recordHealth(workspaceId, capability, provider, result);
  return { provider, result };
}

export const secretNamesOf = (provider: string): readonly string[] => SECRET_ENV[provider] ?? [];
