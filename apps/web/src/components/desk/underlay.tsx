"use client";

import { usePathname, useSearchParams } from "next/navigation";
import React from "react";

/**
 * The page a drawer sits on. A load opens in a drawer over whichever page you were on (Loads, the dispatch queue, an alert),
 * and closing it has to land back there. Browser history cannot say: each action inside the drawer adds an entry for the same
 * load. So the shell remembers the last page that was not a load, and the drawer closes to that.
 */
const UnderlayCtx = React.createContext<React.MutableRefObject<string>>({ current: "/loads" });

export const useUnderlay = () => React.useContext(UnderlayCtx);

export function UnderlayProvider({ children }: { children: React.ReactNode }) {
  const ref = React.useRef("/loads");
  return (
    <UnderlayCtx.Provider value={ref}>
      <React.Suspense fallback={null}>
        <Tracker />
      </React.Suspense>
      {children}
    </UnderlayCtx.Provider>
  );
}

function Tracker() {
  const path = usePathname() ?? "";
  const params = useSearchParams();
  const ref = useUnderlay();
  React.useEffect(() => {
    if (/^\/loads\/[^/]+$/.test(path)) return; // a load (drawer or page) is never the page underneath
    const rest = new URLSearchParams(params.toString());
    rest.delete("note");
    rest.delete("error");
    const qs = rest.toString();
    ref.current = qs ? `${path}?${qs}` : path;
  }, [path, params, ref]);
  return null;
}
