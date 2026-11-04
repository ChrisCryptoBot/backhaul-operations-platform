import React from "react";

/**
 * Says why a screen (or a part of one) is read-only for the signed-in role, and names who on the desk can make the change.
 */
export function ReadOnlyBanner({ who, what = "this screen" }: { who: string; what?: string }) {
  return (
    <p className="tl-note no-print" role="note" style={{ margin: "0 0 14px" }}>
      You can read {what} but not change it. {who} can do this.
    </p>
  );
}

/**
 * Switches off every form control inside when `allowed` is false (the HTML fieldset rule), optionally with a note above naming who can.
 */
export function ReadOnlyGate({
  allowed,
  who,
  what,
  banner = false,
  children
}: {
  allowed: boolean;
  who?: string;
  what?: string;
  banner?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {!allowed && banner && who ? <ReadOnlyBanner who={who} what={what} /> : null}
      <fieldset disabled={!allowed} style={{ display: "contents", border: 0, padding: 0, margin: 0 }}>
        {children}
      </fieldset>
    </>
  );
}
