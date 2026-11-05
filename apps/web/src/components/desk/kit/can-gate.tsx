import React from "react";
import { cache } from "react";
import { checkAccess } from "@/server/tl/access";
import type { Capability } from "@/lib/roles";
import { ReadOnlyGate } from "./read-only";

/** One member lookup per request and set of capabilities, however many rows or buttons ask: a table of fifty rows is still one question. */
const ask = cache((caps: string) => checkAccess(...(caps.split(",") as Capability[])));

/**
 * Switches off every control inside for someone the server would refuse, so a viewer or the billing office does not see a button that only answers "your role does not allow that". The
 * server still refuses on its own (`requireCan` in every action): this is the screen telling the truth, not the lock. Either capability is enough when two are given. Server only.
 */
export async function CanGate({ caps, who, what, banner = false, children }: { caps: Capability[]; who?: string; what?: string; banner?: boolean; children: React.ReactNode }) {
  const access = await ask(caps.join(","));
  return (
    <ReadOnlyGate allowed={access.ok} who={who} what={what} banner={banner}>
      {children}
    </ReadOnlyGate>
  );
}
