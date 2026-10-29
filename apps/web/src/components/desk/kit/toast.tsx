"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React from "react";

type ToastItem = { id: number; text: string; tone: "ok" | "bad" | "plain"; action?: { label: string; run: () => void } };
type Push = (t: { text: string; tone?: ToastItem["tone"]; action?: ToastItem["action"]; ms?: number }) => void;

const ToastCtx = React.createContext<Push>(() => {});
export const useToast = () => React.useContext(ToastCtx);

/** Toasts (with an optional Undo) for the whole desk. Also turns a ?note= or ?error= left by a server action into a toast and clears it from the URL. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const next = React.useRef(1);
  const push = React.useCallback<Push>(({ text, tone = "plain", action, ms = 6000 }) => {
    const id = next.current++;
    setItems((xs) => [...xs, { id, text, tone, action }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), action ? Math.max(ms, 8000) : ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <React.Suspense fallback={null}>
        <UrlFlash />
      </React.Suspense>
      <div className="k-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`k-toast ${t.tone === "plain" ? "" : t.tone}`}>
            <span>{t.text}</span>
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  t.action!.run();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}>
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function UrlFlash() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const push = useToast();
  const note = params.get("note");
  const error = params.get("error");
  React.useEffect(() => {
    if (!note && !error) return;
    push({ text: (error ?? note)!, tone: error ? "bad" : "ok" });
    const rest = new URLSearchParams(params.toString());
    rest.delete("note");
    rest.delete("error");
    const qs = rest.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note, error]);
  return null;
}
