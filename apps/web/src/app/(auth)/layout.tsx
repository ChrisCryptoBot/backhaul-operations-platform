import type { Metadata } from "next";
import type React from "react";
import { LoopIcon } from "@/components/icons";
import "./auth.css";

export const metadata: Metadata = {
  title: "Sign in · Backhaul Bucket",
  description: "Secure access for dispatch operations"
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const showDevAutofill =
    process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_ENABLE_DEV_AUTOFILL === "true";

  return (
    <div className="db-auth-root">
      <aside className="db-auth-panel">
        <div className="db-auth-brand">
          <span className="db-auth-mark" aria-hidden="true">
            <LoopIcon size={24} />
          </span>
          <span className="db-auth-wm">
            <span className="db-auth-wm-name">Backhaul</span>
            <span className="db-auth-wm-sub mono">BUCKET · NORTHEAST</span>
          </span>
        </div>
        <div className="db-auth-pitch">
          <h2>The backhaul board your spreadsheet wishes it was.</h2>
          <p>
            One dense, live load board for the whole desk. Drop a rate con, watch it parse, and keep every
            lot above its backhaul yield — without leaving the keyboard.
          </p>
        </div>
        <div className="db-auth-stats">
          <div className="db-auth-stat">
            <div className="db-auth-stat-v mono">5.8%</div>
            <div className="db-auth-stat-l">Empty miles · wk</div>
          </div>
          <div className="db-auth-stat">
            <div className="db-auth-stat-v mono">$2.42</div>
            <div className="db-auth-stat-l">NBY · $/mi</div>
          </div>
          <div className="db-auth-stat">
            <div className="db-auth-stat-v mono">47</div>
            <div className="db-auth-stat-l">Loads · wk</div>
          </div>
        </div>
      </aside>
      <section className="db-auth-main">
        <div className="db-auth-main-inner">
          {showDevAutofill ? <p className="db-auth-banner warn">DEV MODE: sign-in autofill helper is enabled.</p> : null}
          {children}
        </div>
      </section>
    </div>
  );
}
