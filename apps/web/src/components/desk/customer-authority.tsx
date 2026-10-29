"use client";

import React from "react";
import { noAuthority, normalizeMcNumber, nameToFill, type AuthorityResult, type AuthorityState } from "@/lib/fmcsa";

/**
 * Checks a customer's MC number at FMCSA when its box is left, and shows what came back as a dot and a word. Only a broker or a carrier has an
 * MC: a shipper or direct customer leaves the box blank, and a blank asks nothing and says nothing. The answer is a reading, not a rule: it is
 * never saved and never stops a save. A name is filled in only if the customer's name box is empty.
 */
export function useAuthorityLookup() {
  const [state, setState] = React.useState<{ busy: boolean; result: AuthorityResult | null }>({ busy: false, result: null });
  const seq = React.useRef(0);

  /** Call from the MC box's blur. `fill` is applied only when the name box is still empty by the time the answer arrives. */
  const check = React.useCallback(async (mc: string, currentName: string, fill: (name: string) => void) => {
    const digits = normalizeMcNumber(mc);
    const mine = ++seq.current;
    if (!digits) {
      setState({ busy: false, result: null });
      return;
    }
    setState({ busy: true, result: null });
    try {
      const res = await fetch(`/fmcsa/lookup?mc=${encodeURIComponent(digits)}`);
      const out = (await res.json()) as AuthorityResult;
      if (mine !== seq.current) return;
      setState({ busy: false, result: out });
      const name = nameToFill(currentName, out);
      if (name) fill(name);
    } catch {
      if (mine === seq.current) setState({ busy: false, result: noAuthority("unavailable") });
    }
  }, []);

  /** Call when the MC changes: the last answer is about a different number. */
  const reset = React.useCallback(() => {
    seq.current += 1;
    setState({ busy: false, result: null });
  }, []);

  return { busy: state.busy, result: state.result, check, reset };
}

const TONE: Record<AuthorityState, string> = { broker: "ok", carrier: "info", inactive: "warn", not_found: "warn", unavailable: "muted" };

export function AuthorityStatus({ busy, result }: { busy: boolean; result: AuthorityResult | null }) {
  if (busy) {
    return (
      <span className="rc-authority tl-sub" role="status">
        Checking with FMCSA…
      </span>
    );
  }
  if (!result) return null;
  return (
    <span className="rc-authority" role="status">
      <span className={`tl-chip ${TONE[result.state]}`}>{result.label}</span>
      {result.name ? <span className="tl-sub">{[result.name, result.place].filter(Boolean).join(" · ")}</span> : null}
    </span>
  );
}
