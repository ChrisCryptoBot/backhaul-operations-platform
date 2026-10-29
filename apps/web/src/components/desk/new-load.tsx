"use client";

import Link from "next/link";
import React from "react";
import { Modal } from "./kit/modal";

/** There is no blank load form: a load starts as a priced offer (Quote) or as a document that already says what was agreed (rate confirmation). */
export function NewLoad() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="tl-btn primary" onClick={() => setOpen(true)}>
        New load
      </button>
      <Modal open={open} onClose={() => setOpen(false)} eyebrow="New load" title="Where is it coming from?">
        <div className="nl-doors">
          <Link className="nl-door" href="/quote" onClick={() => setOpen(false)}>
            <b>An offer to price</b>
            <span>Judge it on every truck and driver, then book it.</span>
          </Link>
          <Link className="nl-door" href="/rate-cons" onClick={() => setOpen(false)}>
            <b>A rate confirmation</b>
            <span>Already agreed. Read the document into a draft load.</span>
          </Link>
        </div>
      </Modal>
    </>
  );
}
