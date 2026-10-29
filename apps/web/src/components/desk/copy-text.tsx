"use client";

import React from "react";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

/**
 * Puts a ready-written message on the clipboard, for the dispatcher to paste into their own email. The desk does not send anything outward;
 * this is the hand-off. If the browser will not allow the copy, the message opens in a dialog with the text selected, ready to copy by hand.
 */
export function CopyText({ text, label, size = "sm" }: { text: string; label: string; size?: "sm" | "md" }) {
  const toast = useToast();
  const [shown, setShown] = React.useState(false);
  const box = React.useRef<HTMLTextAreaElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast({ text: "Copied. Paste it into your email.", tone: "ok" });
    } catch {
      setShown(true);
    }
  }

  React.useEffect(() => {
    if (shown) box.current?.select();
  }, [shown]);

  return (
    <>
      <button type="button" className={`tl-btn ${size === "sm" ? "sm" : ""}`} onClick={() => void copy()}>
        {label}
      </button>
      <Modal
        open={shown}
        onClose={() => setShown(false)}
        eyebrow="Ready to paste"
        title={label}
        footer={
          <button type="button" className="tl-btn primary" onClick={() => setShown(false)}>
            Done
          </button>
        }>
        <p className="tl-note" style={{ marginBottom: 8 }}>This browser would not copy it for you. The text is selected: copy it, then paste it into your email.</p>
        <textarea ref={box} readOnly value={text} rows={11} aria-label={label} style={{ width: "100%" }} onFocus={(e) => e.currentTarget.select()} />
      </Modal>
    </>
  );
}
