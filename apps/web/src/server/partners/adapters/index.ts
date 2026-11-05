import { err, type Capability } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import { motiveAdapter } from "./motive";
import { keyMode } from "./sandbox";
import { triumphAdapter } from "./triumphpay";
import type { Adapter, ProviderAdapter } from "./types";

/**
 * The adapters the desk ships, by capability and company. A company with no entry (Samsara, WEX, project44, ...) answers "not implemented" until one is written: a new company is one
 * file with the same three layers (types.ts) and one line here. The router picks live or sandbox per call from the key the fleet typed (sandbox.ts), so the same code path serves a real fleet
 * and a demo.
 */
type Table<K extends Capability> = Record<string, ProviderAdapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]>>;

const SHIPPED: { [K in Capability]?: Table<K> } = {
  eld: { motive: motiveAdapter },
  factoring: { triumphpay: triumphAdapter }
};

/** An adapter for a capability that picks the company's entry, and live or simulator, for each call. */
export function routed<K extends Capability>(capability: K): Adapter<AdapterShapes[K]["in"], AdapterShapes[K]["out"]> {
  return async (call) => {
    const mode = keyMode(call.provider, call.secret);
    if (mode === "refused") return err("not_configured", "A key that starts with sandbox_ runs the built-in simulator, which is only on the demo desk. Use the company's real key.");
    const entry = (SHIPPED[capability] as Table<K> | undefined)?.[call.provider];
    if (!entry) return notImplemented(call.provider);
    return (mode === "sandbox" ? entry.sandbox : entry.live)(call);
  };
}

/** Which companies have an adapter written (live or simulator). For the screen and the tests. */
export const shippedProviders = (capability: Capability): string[] => Object.keys(SHIPPED[capability] ?? {});
